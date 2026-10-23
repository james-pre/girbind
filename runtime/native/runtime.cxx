#include <atomic>
#include <girbind.hxx>
#include <map>
#include <mutex>
#include <thread>
#include <vector>

// The libuv 1.x functions the pump uses. Node exports them; handles are opaque
// and allocated with uv_handle_size, so libuv's headers are not needed.
extern "C" {
typedef struct uv_loop_s uv_loop_t;
typedef struct uv_handle_s uv_handle_t;
typedef void (*uv_close_cb)(uv_handle_t *handle);
typedef void (*uv_handle_cb)(uv_handle_t *handle);
typedef void (*uv_poll_cb)(uv_handle_t *handle, int status, int events);
size_t uv_handle_size(int type);
void uv_handle_set_data(uv_handle_t *handle, void *data);
void *uv_handle_get_data(const uv_handle_t *handle);
void uv_close(uv_handle_t *handle, uv_close_cb callback);
void uv_ref(uv_handle_t *handle);
void uv_unref(uv_handle_t *handle);
int uv_poll_init(uv_loop_t *loop, uv_handle_t *handle, int fd);
int uv_poll_start(uv_handle_t *handle, int events, uv_poll_cb callback);
int uv_poll_stop(uv_handle_t *handle);
int uv_prepare_init(uv_loop_t *loop, uv_handle_t *handle);
int uv_prepare_start(uv_handle_t *handle, uv_handle_cb callback);
int uv_check_init(uv_loop_t *loop, uv_handle_t *handle);
int uv_check_start(uv_handle_t *handle, uv_handle_cb callback);
int uv_timer_init(uv_loop_t *loop, uv_handle_t *handle);
int uv_timer_start(uv_handle_t *handle, uv_handle_cb callback, uint64_t timeout, uint64_t repeat);
int uv_timer_stop(uv_handle_t *handle);
int uv_async_init(uv_loop_t *loop, uv_handle_t *handle, uv_handle_cb callback);
}

namespace {

namespace uv {
constexpr int async = 1, check = 2, poll = 8, prepare = 9, timer = 13;
constexpr int readable = 1, writable = 2, disconnect = 4, prioritized = 8;
} // namespace uv

girbind::Handle *expect_handle(const Napi::CallbackInfo &info) {
	girbind::Handle *handle = girbind::handle_from_external(info[0]);
	if (!handle || !handle->pointer)
		throw Napi::TypeError::New(info.Env(), "Expected a live girbind handle");
	return handle;
}

GObject *expect_object(const Napi::CallbackInfo &info) {
	girbind::Handle *handle = expect_handle(info);
	if (handle->kind != girbind::Kind::Object)
		throw Napi::TypeError::New(info.Env(), "Expected a GObject handle");
	return G_OBJECT(handle->pointer);
}

/** The address of a handle's native value, used as the wrapper identity key. */
Napi::Value address(const Napi::CallbackInfo &info) {
	return Napi::Number::New(
		info.Env(), static_cast<double>(reinterpret_cast<uintptr_t>(expect_handle(info)->pointer))
	);
}

/** The GType names a handle's value can be wrapped as, most derived first. */
Napi::Value type_chain(const Napi::CallbackInfo &info) {
	Napi::Env env = info.Env();
	girbind::Handle *handle = expect_handle(info);
	Napi::Array chain = Napi::Array::New(env);
	uint32_t index = 0;
	if (handle->kind != girbind::Kind::Object) {
		chain.Set(index++, Napi::String::New(env, g_type_name(handle->type)));
		chain.Set(index++, Napi::String::New(env, "GBoxed"));
		return chain;
	}
	for (GType type = G_OBJECT_TYPE(handle->pointer); type; type = g_type_parent(type)) {
		chain.Set(index++, Napi::String::New(env, g_type_name(type)));
	}
	return chain;
}

/** Drop a handle's reference now instead of when it is collected. */
Napi::Value release(const Napi::CallbackInfo &info) {
	girbind::release(expect_handle(info));
	return info.Env().Undefined();
}

std::atomic<uint64_t> finalized_count = 0;

/** Count the finalization of an object handle's GObject in `finalized()`. */
Napi::Value watch_finalization(const Napi::CallbackInfo &info) {
	g_object_weak_ref(expect_object(info), [](gpointer, GObject *) { finalized_count++; }, nullptr);
	return info.Env().Undefined();
}

Napi::Value finalized(const Napi::CallbackInfo &info) {
	return Napi::Number::New(info.Env(), static_cast<double>(finalized_count.load()));
}

// --- pump ----------------------------------------------------------------------

/** A file descriptor GLib wants polled, watched by one libuv poll handle. */
struct Watch {
	int fd;
	uv_handle_t *handle = nullptr;
	int events = 0;
	int fired = 0;
};

/** Iterates the default GLib main context from the libuv loop of the main thread. */
struct Pump {
	napi_env env;
	std::thread::id thread;
	GMainContext *context;
	uv_loop_t *loop;
	uv_handle_t *prepare;
	uv_handle_t *check;
	uv_handle_t *timer;
	uv_handle_t *keepalive;
	std::map<int, Watch> watches;
	std::vector<GPollFD> fds;
	gint max_priority = 0;
	bool prepared = false;
	uint32_t holds = 0;
	napi_ref resource;
	napi_async_context async_context;
	std::mutex pending_mutex;
	std::vector<napi_ref> pending_deletes;
};

Pump *pump = nullptr;

bool on_main_thread() {
	return pump && std::this_thread::get_id() == pump->thread;
}

uv_handle_t *new_uv_handle(int type) {
	auto *handle = static_cast<uv_handle_t *>(g_malloc0(uv_handle_size(type)));
	uv_handle_set_data(handle, pump);
	return handle;
}

void free_uv_handle(uv_handle_t *handle) {
	g_free(handle);
}

int uv_events(gushort events) {
	int result = 0;
	if (events & G_IO_IN)
		result |= uv::readable;
	if (events & G_IO_OUT)
		result |= uv::writable;
	if (events & G_IO_PRI)
		result |= uv::prioritized;
	return result;
}

gushort glib_events(int events) {
	gushort result = 0;
	if (events & uv::readable)
		result |= G_IO_IN;
	if (events & uv::writable)
		result |= G_IO_OUT;
	if (events & uv::prioritized)
		result |= G_IO_PRI;
	if (events & uv::disconnect)
		result |= G_IO_HUP;
	return result;
}

void on_poll(uv_handle_t *handle, int status, int events) {
	auto *watch = static_cast<Watch *>(uv_handle_get_data(handle));
	watch->fired |= status < 0 ? -1 : events;
}

void on_timer(uv_handle_t *) {}

void on_keepalive(uv_handle_t *) {}

void drain_pending_deletes() {
	std::vector<napi_ref> deletes;
	{
		std::lock_guard lock(pump->pending_mutex);
		deletes.swap(pump->pending_deletes);
	}
	for (napi_ref reference : deletes)
		napi_delete_reference(pump->env, reference);
}

/** Ask GLib what to wait for, and arm libuv poll handles and a timer to match. */
void on_prepare(uv_handle_t *) {
	if (pump->prepared)
		return;
	g_main_context_prepare(pump->context, &pump->max_priority);
	gint timeout = -1;
	for (;;) {
		gint count = g_main_context_query(
			pump->context, pump->max_priority, &timeout, pump->fds.data(), static_cast<gint>(pump->fds.size())
		);
		bool fits = static_cast<size_t>(count) <= pump->fds.size();
		pump->fds.resize(count);
		if (fits)
			break;
	}
	pump->prepared = true;

	std::map<int, int> wanted;
	for (const GPollFD &fd : pump->fds)
		wanted[fd.fd] |= uv_events(fd.events);

	for (auto it = pump->watches.begin(); it != pump->watches.end();) {
		if (wanted.contains(it->first)) {
			++it;
			continue;
		}
		uv_poll_stop(it->second.handle);
		uv_close(it->second.handle, free_uv_handle);
		it = pump->watches.erase(it);
	}

	for (auto [fd, events] : wanted) {
		Watch &watch = pump->watches[fd];
		watch.fd = fd;
		watch.fired = 0;
		if (!watch.handle) {
			watch.handle = new_uv_handle(uv::poll);
			if (uv_poll_init(pump->loop, watch.handle, fd) != 0) {
				g_free(watch.handle);
				pump->watches.erase(fd);
				continue;
			}
			uv_handle_set_data(watch.handle, &watch);
			uv_unref(watch.handle);
		}
		if (watch.events != events) {
			if (uv_poll_start(watch.handle, events, on_poll) != 0)
				g_warning("girbind: cannot watch file descriptor %d for GLib", fd);
			watch.events = events;
		}
	}

	if (timeout >= 0)
		uv_timer_start(pump->timer, on_timer, static_cast<uint64_t>(timeout), 0);
	else
		uv_timer_stop(pump->timer);
}

/** Dispatch the GLib sources that became ready, inside a Node callback scope so microtasks run after. */
void on_check(uv_handle_t *) {
	if (!pump->prepared)
		return;
	pump->prepared = false;
	for (GPollFD &fd : pump->fds) {
		auto watch = pump->watches.find(fd.fd);
		int fired = watch == pump->watches.end() ? 0 : watch->second.fired;
		fd.revents = fired < 0 ? G_IO_ERR : glib_events(fired) & (fd.events | G_IO_HUP | G_IO_ERR);
	}
	for (auto &[fd, watch] : pump->watches)
		watch.fired = 0;

	if (g_main_context_check(pump->context, pump->max_priority, pump->fds.data(), static_cast<gint>(pump->fds.size()))) {
		napi_handle_scope handle_scope;
		napi_open_handle_scope(pump->env, &handle_scope);
		napi_value resource;
		napi_get_reference_value(pump->env, pump->resource, &resource);
		napi_callback_scope scope;
		napi_open_callback_scope(pump->env, resource, pump->async_context, &scope);
		g_main_context_dispatch(pump->context);
		napi_close_callback_scope(pump->env, scope);
		napi_close_handle_scope(pump->env, handle_scope);
	}
	drain_pending_deletes();
}

void stop_pump(void *) {
	for (auto &[fd, watch] : pump->watches) {
		uv_poll_stop(watch.handle);
		uv_close(watch.handle, free_uv_handle);
	}
	pump->watches.clear();
	for (uv_handle_t *handle : {pump->prepare, pump->check, pump->timer, pump->keepalive})
		uv_close(handle, free_uv_handle);
	g_main_context_release(pump->context);
	napi_async_destroy(pump->env, pump->async_context);
	napi_delete_reference(pump->env, pump->resource);
	pump = nullptr;
}

/** Start iterating the default main context from this environment's loop; only the first environment does. */
void start_pump(Napi::Env env) {
	if (pump)
		return;
	GMainContext *context = g_main_context_default();
	if (!g_main_context_acquire(context)) {
		g_warning("girbind: the default GLib main context is owned by another thread; GLib events will not run");
		return;
	}
	pump = new Pump{};
	pump->env = env;
	pump->thread = std::this_thread::get_id();
	pump->context = context;
	napi_get_uv_event_loop(env, reinterpret_cast<struct uv_loop_s **>(&pump->loop));

	Napi::Object resource = Napi::Object::New(env);
	napi_create_reference(env, resource, 1, &pump->resource);
	napi_async_init(env, resource, Napi::String::New(env, "girbind:GLib"), &pump->async_context);

	pump->prepare = new_uv_handle(uv::prepare);
	uv_prepare_init(pump->loop, pump->prepare);
	uv_prepare_start(pump->prepare, on_prepare);
	pump->check = new_uv_handle(uv::check);
	uv_check_init(pump->loop, pump->check);
	uv_check_start(pump->check, on_check);
	pump->timer = new_uv_handle(uv::timer);
	uv_timer_init(pump->loop, pump->timer);
	pump->keepalive = new_uv_handle(uv::async);
	uv_async_init(pump->loop, pump->keepalive, on_keepalive);
	for (uv_handle_t *handle : {pump->prepare, pump->check, pump->timer, pump->keepalive})
		uv_unref(handle);

	napi_add_env_cleanup_hook(env, stop_pump, nullptr);
}

/** Keep the Node process alive while at least one hold is outstanding. */
Napi::Value hold_loop(const Napi::CallbackInfo &info) {
	if (pump && pump->holds++ == 0)
		uv_ref(pump->keepalive);
	return info.Env().Undefined();
}

Napi::Value release_loop(const Napi::CallbackInfo &info) {
	if (pump && pump->holds && --pump->holds == 0)
		uv_unref(pump->keepalive);
	return info.Env().Undefined();
}

// --- signals -------------------------------------------------------------------

/** A GClosure that calls a JS function. */
struct JsClosure {
	GClosure closure;
	napi_env env;
	napi_ref function;
};

void finalize_closure(gpointer, GClosure *closure) {
	auto *js = reinterpret_cast<JsClosure *>(closure);
	if (!pump)
		return;
	if (on_main_thread()) {
		napi_delete_reference(js->env, js->function);
		return;
	}
	std::lock_guard lock(pump->pending_mutex);
	pump->pending_deletes.push_back(js->function);
}

/** Report an exception thrown by a signal handler as uncaught, as Node does for timers and events. */
void report(napi_env env, napi_value error) {
	napi_fatal_exception(env, error);
}

void marshal(
	GClosure *closure, GValue *return_value, guint count, const GValue *params, gpointer, gpointer
) {
	auto *js = reinterpret_cast<JsClosure *>(closure);
	if (!on_main_thread()) {
		g_critical("girbind: a signal was emitted on a thread other than the main thread; its JS handler was skipped");
		return;
	}
	napi_env env = js->env;
	Napi::HandleScope scope(env);
	try {
		std::vector<napi_value> args;
		for (guint i = 0; i < count; i++)
			args.push_back(girbind::value_to_js(env, &params[i]));
		napi_value function, receiver, result;
		napi_get_reference_value(env, js->function, &function);
		napi_get_undefined(env, &receiver);
		if (napi_call_function(env, receiver, function, args.size(), args.data(), &result) != napi_ok) {
			napi_value error;
			napi_get_and_clear_last_exception(env, &error);
			report(env, error);
			return;
		}
		if (return_value && G_VALUE_TYPE(return_value) != G_TYPE_INVALID && G_VALUE_TYPE(return_value) != G_TYPE_NONE)
			girbind::value_from_js(Napi::Value(env, result), return_value);
	} catch (const Napi::Error &error) {
		report(env, error.Value());
	}
}

/** `connect(handle, signal, handler, after)`: connect a JS handler to a (possibly detailed) signal. */
Napi::Value connect(const Napi::CallbackInfo &info) {
	Napi::Env env = info.Env();
	GObject *object = expect_object(info);
	std::string name = info[1].As<Napi::String>().Utf8Value();
	Napi::Function handler = info[2].As<Napi::Function>();
	bool after = info[3].ToBoolean().Value();

	guint signal_id;
	GQuark detail;
	if (!g_signal_parse_name(name.c_str(), G_OBJECT_TYPE(object), &signal_id, &detail, TRUE)) {
		throw Napi::TypeError::New(env, std::string(G_OBJECT_TYPE_NAME(object)) + " has no signal \"" + name + "\"");
	}

	auto *js = reinterpret_cast<JsClosure *>(g_closure_new_simple(sizeof(JsClosure), nullptr));
	js->env = env;
	napi_create_reference(env, handler, 1, &js->function);
	g_closure_set_marshal(&js->closure, marshal);
	g_closure_add_finalize_notifier(&js->closure, nullptr, finalize_closure);
	gulong id = g_signal_connect_closure_by_id(object, signal_id, detail, &js->closure, after);
	return Napi::Number::New(env, static_cast<double>(id));
}

Napi::Value disconnect(const Napi::CallbackInfo &info) {
	GObject *object = expect_object(info);
	auto id = static_cast<gulong>(info[1].As<Napi::Number>().Int64Value());
	if (g_signal_handler_is_connected(object, id))
		g_signal_handler_disconnect(object, id);
	return info.Env().Undefined();
}

/** `timeout(milliseconds, callback)`: call `callback` once from a GLib timeout source, for tests. */
Napi::Value timeout(const Napi::CallbackInfo &info) {
	struct Pending {
		napi_env env;
		napi_ref callback;
	};
	auto *pending = new Pending{info.Env(), nullptr};
	napi_create_reference(info.Env(), info[1], 1, &pending->callback);
	g_timeout_add(
		info[0].As<Napi::Number>().Uint32Value(),
		[](gpointer data) -> gboolean {
			auto *pending = static_cast<Pending *>(data);
			napi_value callback, receiver, result;
			napi_get_reference_value(pending->env, pending->callback, &callback);
			napi_get_undefined(pending->env, &receiver);
			if (napi_call_function(pending->env, receiver, callback, 0, nullptr, &result) != napi_ok) {
				napi_value error;
				napi_get_and_clear_last_exception(pending->env, &error);
				report(pending->env, error);
			}
			napi_delete_reference(pending->env, pending->callback);
			delete pending;
			return G_SOURCE_REMOVE;
		},
		pending
	);
	return info.Env().Undefined();
}

Napi::Value init_self(const Napi::CallbackInfo &info) {
	girbind::init(info);
	return info.Env().Undefined();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
	exports.Set("abi", Napi::Number::New(env, girbind::abi_version));
	exports.Set("$init", Napi::Function::New(env, init_self));
	exports.Set("address", Napi::Function::New(env, address));
	exports.Set("typeChain", Napi::Function::New(env, type_chain));
	exports.Set("release", Napi::Function::New(env, release));
	exports.Set("watchFinalization", Napi::Function::New(env, watch_finalization));
	exports.Set("finalized", Napi::Function::New(env, finalized));
	exports.Set("holdLoop", Napi::Function::New(env, hold_loop));
	exports.Set("releaseLoop", Napi::Function::New(env, release_loop));
	exports.Set("connect", Napi::Function::New(env, connect));
	exports.Set("disconnect", Napi::Function::New(env, disconnect));
	exports.Set("timeout", Napi::Function::New(env, timeout));
	start_pump(env);
	return exports;
}

} // namespace

NODE_API_MODULE(girbind, Init)
