// girbind runtime ABI, shared by the runtime addon and every generated addon.
//
// A wrapper object stores its native value as a type-tagged `External` under
// `Symbol.for("girbind.handle")`. Any addon can read a handle; wrappers for
// existing objects are created by the runtime's `wrap`, and classes and
// interfaces are registered with the runtime by GType name so other addons can
// extend and implement them. Callbacks and asynchronous calls let C call JS
// functions and settle promises from the GLib main loop, which the runtime
// iterates on the main thread.
// The layout of `Handle` is part of the ABI: change `abi_version` with it.

#pragma once

#include <cstring>
#include <glib-object.h>
#include <initializer_list>
#include <memory>
#include <napi.h>
#include <string>
#include <thread>
#include <vector>

namespace girbind {

inline constexpr uint32_t abi_version = 5;

enum class Kind : uint32_t { Object, Boxed, Plain };

/**
 * A toggle reference keeping a JS subclass instance's wrapper alive while C
 * holds other references to its object, and collectable once it does not.
 */
struct Toggle {
	napi_env env;
	/** The wrapper, held strongly while `strong`. */
	napi_ref wrapper;
	GToggleNotify notify;
	bool strong = false;
};

struct Handle {
	Kind kind;
	GType type;
	gpointer pointer;
	/** For a JS subclass instance whose wrapper is attached, the toggle reference the handle holds. */
	Toggle *toggle = nullptr;
};

inline constexpr napi_type_tag handle_tag = {0x6769726269e4d001, 0x9a3c5b7e21f04d8c};

inline void release(Handle *handle) {
	if (!handle->pointer)
		return;
	switch (handle->kind) {
		case Kind::Object:
			if (Toggle *toggle = handle->toggle) {
				g_object_remove_toggle_ref(G_OBJECT(handle->pointer), toggle->notify, toggle);
				napi_delete_reference(toggle->env, toggle->wrapper);
				delete toggle;
				handle->toggle = nullptr;
			} else {
				g_object_unref(handle->pointer);
			}
			break;
		case Kind::Boxed: g_boxed_free(handle->type, handle->pointer); break;
		case Kind::Plain: g_free(handle->pointer); break;
	}
	handle->pointer = nullptr;
}

inline Napi::External<Handle> new_handle(Napi::Env env, Handle *handle) {
	auto external = Napi::External<Handle>::New(env, handle, [](Napi::Env, Handle *owned) {
		release(owned);
		delete owned;
	});
	external.TypeTag(&handle_tag);
	return external;
}

/** Take a reference to `object` (sinking a floating one) unless the caller already owns one. */
inline Napi::External<Handle> object_handle(Napi::Env env, gpointer object, bool owned) {
	if (g_object_is_floating(object)) {
		g_object_ref_sink(object);
	} else if (!owned) {
		g_object_ref(object);
	}
	return new_handle(env, new Handle{Kind::Object, G_OBJECT_TYPE(object), object});
}

/** The handle stored in a handle `External`, or null if `value` is not one. */
inline Handle *handle_from_external(Napi::Value value) {
	if (!value.IsExternal())
		return nullptr;
	auto external = value.As<Napi::External<Handle>>();
	if (!external.CheckTypeTag(&handle_tag))
		return nullptr;
	return external.Data();
}

/** Per-environment state an addon receives from the runtime in `$init`. */
struct Runtime {
	Napi::FunctionReference wrap;
	Napi::FunctionReference attach;
	Napi::FunctionReference register_class;
	Napi::FunctionReference register_interface;
	Napi::FunctionReference lookup;
	Napi::FunctionReference hold_loop;
	Napi::FunctionReference release_loop;
	Napi::FunctionReference on_abort;
	Napi::FunctionReference construct_object;
	Napi::Reference<Napi::Symbol> key;
	Napi::Reference<Napi::Symbol> adopt;
};

/** The thread an addon's environment runs on, and whether that environment is still alive. */
struct Environment {
	napi_env env = nullptr;
	std::thread::id thread;
	bool alive = false;
};

inline Environment environment;

/** Whether JS can be called from here: on the environment's thread, before it is torn down. */
inline bool on_main_thread() {
	return environment.alive && std::this_thread::get_id() == environment.thread;
}

inline Runtime &runtime(Napi::Env env) {
	Runtime *state = env.GetInstanceData<Runtime>();
	if (!state)
		throw Napi::Error::New(env, "girbind: addon used before $init");
	return *state;
}

/** Store the runtime's ABI object, passed to an addon's `$init` by its generated entry point. */
inline void init(const Napi::CallbackInfo &info) {
	Napi::Env env = info.Env();
	Napi::Object abi = info[0].As<Napi::Object>();
	uint32_t version = abi.Get("abi").As<Napi::Number>().Uint32Value();
	if (version != abi_version) {
		throw Napi::Error::New(
			env,
			"girbind: runtime ABI " + std::to_string(version) + " does not match addon ABI " +
				std::to_string(abi_version)
		);
	}
	env.SetInstanceData(new Runtime{
		Napi::Persistent(abi.Get("wrap").As<Napi::Function>()),
		Napi::Persistent(abi.Get("attach").As<Napi::Function>()),
		Napi::Persistent(abi.Get("register").As<Napi::Function>()),
		Napi::Persistent(abi.Get("registerInterface").As<Napi::Function>()),
		Napi::Persistent(abi.Get("lookup").As<Napi::Function>()),
		Napi::Persistent(abi.Get("holdLoop").As<Napi::Function>()),
		Napi::Persistent(abi.Get("releaseLoop").As<Napi::Function>()),
		Napi::Persistent(abi.Get("onAbort").As<Napi::Function>()),
		Napi::Persistent(abi.Get("constructObject").As<Napi::Function>()),
		Napi::Persistent(abi.Get("handle").As<Napi::Symbol>()),
		Napi::Persistent(abi.Get("adopt").As<Napi::Symbol>()),
	});
	environment = {env, std::this_thread::get_id(), true};
	napi_add_env_cleanup_hook(env, [](void *) { environment.alive = false; }, nullptr);
}

/** Call a runtime function for its effect, ignoring any exception, as destructors must not throw. */
inline void call_quietly(napi_env env, const Napi::FunctionReference &function) {
	napi_value receiver, result;
	napi_get_undefined(env, &receiver);
	if (napi_call_function(env, receiver, function.Value(), 0, nullptr, &result) != napi_ok) {
		napi_value exception;
		napi_get_and_clear_last_exception(env, &exception);
	}
}

/** A JS error for `error`, with its GLib error domain and code, freeing `error`. */
inline Napi::Error from_gerror(Napi::Env env, GError *error) {
	Napi::Error result = Napi::Error::New(env, error->message);
	result.Value().Set("domain", Napi::String::New(env, g_quark_to_string(error->domain)));
	result.Value().Set("code", Napi::Number::New(env, error->code));
	g_error_free(error);
	return result;
}

inline Handle *handle_of(Napi::Value value) {
	if (!value.IsObject())
		return nullptr;
	return handle_from_external(value.As<Napi::Object>().Get(runtime(value.Env()).key.Value()));
}

/** A registered GType by name, or 0 when no type of that name exists yet. */
inline GType type_named(const char *name) {
	return g_type_from_name(name);
}

/** The GObject behind `value` if it is an instance of `type`; throws a TypeError otherwise. */
template <typename T = void> T *unwrap_object(Napi::Value value, GType type, const char *name, bool nullable = false) {
	if (nullable && (value.IsNull() || value.IsUndefined()))
		return nullptr;
	Handle *handle = handle_of(value);
	if (!handle || handle->kind != Kind::Object || !handle->pointer || !type ||
		!g_type_check_instance_is_a(static_cast<GTypeInstance *>(handle->pointer), type)) {
		throw Napi::TypeError::New(value.Env(), std::string("Expected ") + name);
	}
	return static_cast<T *>(handle->pointer);
}

/** The wrapper for `object`, creating one through the runtime if it has none. */
inline Napi::Value wrap_object(Napi::Env env, gpointer object, bool owned) {
	if (!object)
		return env.Null();
	return runtime(env).wrap.Call({object_handle(env, object, owned)});
}

using Callback = Napi::Value (*)(const Napi::CallbackInfo &);

/** A class's JS name and its native constructor, which returns a handle; null for classes without one. */
struct ClassInfo {
	const char *name;
	Callback construct;
	/** The JS class, once defined, which `new.target` differs from when a JS subclass is constructed. */
	mutable napi_ref cls = nullptr;
};

/** Set a JS subclass's override of the virtual method `name` in its class struct, returning whether it has one. */
using Installer = gboolean (*)(gpointer type_class, const char *name);

struct Accessor {
	Callback get;
	Callback set;
};

inline napi_value invoke(Callback callback, napi_env env, napi_callback_info raw) {
	Napi::CallbackInfo info(env, raw);
	try {
		return callback(info);
	} catch (const Napi::Error &error) {
		error.ThrowAsJavaScriptException();
		return nullptr;
	}
}

inline napi_value invoke_method(napi_env env, napi_callback_info raw) {
	void *data = nullptr;
	napi_get_cb_info(env, raw, nullptr, nullptr, nullptr, &data);
	return invoke(reinterpret_cast<Callback>(data), env, raw);
}

inline napi_value invoke_getter(napi_env env, napi_callback_info raw) {
	void *data = nullptr;
	napi_get_cb_info(env, raw, nullptr, nullptr, nullptr, &data);
	return invoke(static_cast<const Accessor *>(data)->get, env, raw);
}

inline napi_value invoke_setter(napi_env env, napi_callback_info raw) {
	void *data = nullptr;
	napi_get_cb_info(env, raw, nullptr, nullptr, nullptr, &data);
	return invoke(static_cast<const Accessor *>(data)->set, env, raw);
}

/** A handle to a new instance of `new.target`, from the GObject properties in the first argument, if any. */
inline Napi::Value construct_object(const Napi::CallbackInfo &info) {
	return runtime(info.Env()).construct_object.Call({info.NewTarget(), info[0]});
}

/** Whether a constructor argument is an object of GObject properties, which no C constructor argument can be. */
inline bool is_properties(Napi::Value value) {
	return value.IsObject() && !value.IsArray() && !value.IsTypedArray() && !value.IsArrayBuffer() &&
		   !value.IsFunction() && !handle_of(value);
}

/**
 * A class's JS constructor: adopt an existing handle, create an instance of a
 * JS subclass or from an object of GObject properties, or call the C constructor.
 */
inline Napi::Value construct(const Napi::CallbackInfo &info) {
	Napi::Env env = info.Env();
	auto *class_info = static_cast<const ClassInfo *>(info.Data());
	if (!info.IsConstructCall()) {
		throw Napi::TypeError::New(
			env, std::string("Class constructor ") + class_info->name + " cannot be invoked without 'new'"
		);
	}
	Runtime &state = runtime(env);
	Napi::Value handle;
	napi_value cls = nullptr;
	if (class_info->cls)
		napi_get_reference_value(env, class_info->cls, &cls);
	bool subclass = cls && !info.NewTarget().StrictEquals(Napi::Value(env, cls));
	bool properties = info.Length() == 1 && is_properties(info[0]);
	if (info.Length() >= 2 && info[0].StrictEquals(state.adopt.Value())) {
		handle = info[1];
	} else if (subclass || properties) {
		handle = construct_object(info);
	}
	if (handle.IsEmpty() || handle.IsUndefined()) {
		if (!class_info->construct)
			throw Napi::TypeError::New(env, std::string(class_info->name) + " cannot be constructed directly");
		handle = class_info->construct(info);
	}
	state.attach.Call({info.This(), handle});
	return info.This();
}

inline napi_value invoke_constructor(napi_env env, napi_callback_info raw) {
	return invoke(construct, env, raw);
}

/** A registered class by GType name, from this addon or any other. */
inline Napi::Function lookup(Napi::Env env, const char *type_name) {
	return runtime(env).lookup.Call({Napi::String::New(env, type_name)}).As<Napi::Function>();
}

inline Napi::Function new_class(Napi::Env env, const ClassInfo &info) {
	napi_value constructor;
	napi_status status = napi_define_class(
		env, info.name, NAPI_AUTO_LENGTH, invoke_constructor, const_cast<ClassInfo *>(&info), 0, nullptr, &constructor
	);
	if (status != napi_ok)
		throw Napi::Error::New(env);
	napi_create_reference(env, constructor, 1, &info.cls);
	return Napi::Function(env, constructor);
}

/** A function returning the GType of a class or interface, registering it if needed. */
inline Napi::Function gtype_function(Napi::Env env, const char *type_name, GType (*get_type)(void)) {
	return Napi::Function::New(env, [type_name, get_type](const Napi::CallbackInfo &info) {
		GType type = get_type ? get_type() : g_type_from_name(type_name);
		return Napi::Number::New(info.Env(), static_cast<double>(type));
	});
}

/**
 * Define a class extending `parent` and register it with the runtime under
 * `type_name`, adding the members of the registered `interfaces` it implements.
 * `install` sets JS subclasses' overrides of the virtual methods its class
 * struct declares.
 */
inline Napi::Function define_class(
	Napi::Env env,
	const ClassInfo &info,
	const char *type_name,
	Napi::Function parent,
	std::initializer_list<const char *> interfaces,
	GType (*get_type)(void),
	Installer install
) {
	Napi::Function cls = new_class(env, info);
	Napi::Function set_prototype_of =
		env.Global().Get("Object").As<Napi::Object>().Get("setPrototypeOf").As<Napi::Function>();
	set_prototype_of.Call({cls.Get("prototype"), parent.Get("prototype")});
	set_prototype_of.Call({cls, parent});
	Napi::Array names = Napi::Array::New(env, interfaces.size());
	uint32_t index = 0;
	for (const char *name : interfaces)
		names.Set(index++, Napi::String::New(env, name));
	Napi::Value installer =
		install ? Napi::External<void>::New(env, reinterpret_cast<void *>(install)) : env.Undefined();
	runtime(env).register_class.Call(
		{Napi::String::New(env, type_name), cls, names, gtype_function(env, type_name, get_type), installer}
	);
	return cls;
}

/** Define an interface, whose prototype holds the members its implementations share, and register it. */
inline Napi::Function define_interface(
	Napi::Env env,
	const ClassInfo &info,
	const char *type_name,
	GType (*get_type)(void)
) {
	Napi::Function iface = new_class(env, info);
	runtime(env).register_interface.Call(
		{Napi::String::New(env, type_name), iface, gtype_function(env, type_name, get_type)}
	);
	return iface;
}

// --- subclasses ------------------------------------------------------------------

/** Marks the GTypes registered for JS subclasses. */
inline GQuark subclass_quark() {
	return g_quark_from_static_string("girbind-subclass");
}

/** The class struct of the nearest ancestor of an instance's type that is not a JS subclass, for chaining up. */
inline gpointer native_class(gpointer instance) {
	GType type = G_TYPE_FROM_INSTANCE(instance);
	while (g_type_get_qdata(type, subclass_quark()))
		type = g_type_parent(type);
	return g_type_class_peek(type);
}

/**
 * Call the JS override `name` of `instance`'s wrapper with the arguments
 * `arguments` pushes, passing what it returns to `result`. An exception is
 * reported as uncaught, and the C caller gets zero values.
 */
template <typename Arguments, typename Result>
void call_override(gpointer instance, const char *name, Arguments arguments, Result result) {
	if (!on_main_thread()) {
		if (environment.alive)
			g_critical(
				"girbind: %s was called on a thread other than the main thread; its JS override was skipped", name
			);
		return;
	}
	Napi::Env env(environment.env);
	Napi::HandleScope scope(env);
	try {
		Napi::Object self = wrap_object(env, instance, false).As<Napi::Object>();
		Napi::Function method = self.Get(name).As<Napi::Function>();
		std::vector<napi_value> args;
		arguments(env, args);
		result(env, method.Call(self, args));
	} catch (const Napi::Error &error) {
		napi_fatal_exception(env, error.Value());
	}
}

/** Define a non-enumerable method, like a class method in JS. */
inline void define_method(Napi::Object target, const char *name, Callback callback) {
	napi_property_descriptor descriptor = {
		name,
		nullptr,
		invoke_method,
		nullptr,
		nullptr,
		nullptr,
		static_cast<napi_property_attributes>(napi_writable | napi_configurable),
		reinterpret_cast<void *>(callback)
	};
	napi_status status = napi_define_properties(target.Env(), target, 1, &descriptor);
	if (status != napi_ok)
		throw Napi::Error::New(target.Env());
}

inline void define_accessor(Napi::Object target, const char *name, const Accessor &accessor) {
	napi_property_descriptor descriptor = {
		name,
		nullptr,
		nullptr,
		accessor.get ? invoke_getter : nullptr,
		accessor.set ? invoke_setter : nullptr,
		nullptr,
		napi_configurable,
		const_cast<Accessor *>(&accessor)
	};
	napi_status status = napi_define_properties(target.Env(), target, 1, &descriptor);
	if (status != napi_ok)
		throw Napi::Error::New(target.Env());
}

// --- records -----------------------------------------------------------------

/** Copy `record` into a new handle unless the caller already owns it. */
inline Napi::External<Handle> boxed_handle(Napi::Env env, GType type, gconstpointer record, bool owned) {
	gpointer pointer = owned ? const_cast<gpointer>(record) : g_boxed_copy(type, record);
	return new_handle(env, new Handle{Kind::Boxed, type, pointer});
}

/** The GType identifying a plain struct without a boxed GType, registered on first use by every addon alike. */
inline GType plain_type(const char *c_type) {
	std::string name = std::string("girbind+") + c_type;
	GType type = g_type_from_name(name.c_str());
	return type ? type : g_pointer_type_register_static(name.c_str());
}

/** Copy a plain struct of `size` bytes into a new handle unless the caller already owns it. */
inline Napi::External<Handle> plain_handle(Napi::Env env, GType type, gconstpointer record, size_t size, bool owned) {
	gpointer pointer = const_cast<gpointer>(record);
	if (!owned) {
		pointer = g_malloc(size);
		memcpy(pointer, record, size);
	}
	return new_handle(env, new Handle{Kind::Plain, type, pointer});
}

inline Napi::Value wrap_handle(Napi::Env env, Napi::External<Handle> handle) {
	return runtime(env).wrap.Call({handle});
}

inline Napi::Value wrap_boxed(Napi::Env env, GType type, gconstpointer record, bool owned) {
	if (!record)
		return env.Null();
	return wrap_handle(env, boxed_handle(env, type, record, owned));
}

inline Napi::Value wrap_plain(Napi::Env env, GType type, gconstpointer record, size_t size, bool owned) {
	if (!record)
		return env.Null();
	return wrap_handle(env, plain_handle(env, type, record, size, owned));
}

/** The record behind `value` if it holds a record of `type`; throws a TypeError otherwise. */
template <typename T = void> T *unwrap_record(Napi::Value value, GType type, const char *name, bool nullable = false) {
	if (nullable && (value.IsNull() || value.IsUndefined()))
		return nullptr;
	Handle *handle = handle_of(value);
	if (!handle || handle->kind == Kind::Object || !handle->pointer || handle->type != type) {
		throw Napi::TypeError::New(value.Env(), std::string("Expected ") + name);
	}
	return static_cast<T *>(handle->pointer);
}

// --- GValue ------------------------------------------------------------------

/** Convert a GValue to JS: numbers, strings, wrapped objects and boxed records. */
inline Napi::Value value_to_js(Napi::Env env, const GValue *value) {
	GType type = G_VALUE_TYPE(value);
	switch (G_TYPE_FUNDAMENTAL(type)) {
		case G_TYPE_INVALID:
		case G_TYPE_NONE: return env.Undefined();
		case G_TYPE_BOOLEAN: return Napi::Boolean::New(env, g_value_get_boolean(value));
		case G_TYPE_CHAR: return Napi::Number::New(env, g_value_get_schar(value));
		case G_TYPE_UCHAR: return Napi::Number::New(env, g_value_get_uchar(value));
		case G_TYPE_INT: return Napi::Number::New(env, g_value_get_int(value));
		case G_TYPE_UINT: return Napi::Number::New(env, g_value_get_uint(value));
		case G_TYPE_LONG: return Napi::Number::New(env, static_cast<double>(g_value_get_long(value)));
		case G_TYPE_ULONG: return Napi::Number::New(env, static_cast<double>(g_value_get_ulong(value)));
		case G_TYPE_INT64: return Napi::Number::New(env, static_cast<double>(g_value_get_int64(value)));
		case G_TYPE_UINT64: return Napi::Number::New(env, static_cast<double>(g_value_get_uint64(value)));
		case G_TYPE_FLOAT: return Napi::Number::New(env, g_value_get_float(value));
		case G_TYPE_DOUBLE: return Napi::Number::New(env, g_value_get_double(value));
		case G_TYPE_ENUM: return Napi::Number::New(env, g_value_get_enum(value));
		case G_TYPE_FLAGS: return Napi::Number::New(env, g_value_get_flags(value));
		case G_TYPE_STRING: {
			const char *string = g_value_get_string(value);
			return string ? Napi::String::New(env, string) : env.Null();
		}
		case G_TYPE_OBJECT:
		case G_TYPE_INTERFACE: return wrap_object(env, g_value_get_object(value), false);
		case G_TYPE_PARAM: {
			GParamSpec *spec = g_value_get_param(value);
			if (!spec)
				return env.Null();
			Napi::Object description = Napi::Object::New(env);
			description.Set("name", g_param_spec_get_name(spec));
			return description;
		}
		case G_TYPE_BOXED: {
			if (type == G_TYPE_STRV) {
				auto strings = static_cast<const char *const *>(g_value_get_boxed(value));
				Napi::Array array = Napi::Array::New(env);
				for (uint32_t i = 0; strings && strings[i]; i++)
					array.Set(i, Napi::String::New(env, strings[i]));
				return array;
			}
			return wrap_boxed(env, type, g_value_get_boxed(value), false);
		}
		default: return env.Undefined();
	}
}

inline std::string type_description(GType type) {
	const char *name = g_type_name(type);
	return name ? name : "unknown type";
}

/** Store a JS value into `value`, which must already be initialized to its target type. */
inline void value_from_js(Napi::Value source, GValue *value) {
	Napi::Env env = source.Env();
	GType type = G_VALUE_TYPE(value);
	switch (G_TYPE_FUNDAMENTAL(type)) {
		case G_TYPE_BOOLEAN: g_value_set_boolean(value, source.ToBoolean().Value()); return;
		case G_TYPE_CHAR: g_value_set_schar(value, static_cast<gint8>(source.ToNumber().Int32Value())); return;
		case G_TYPE_UCHAR: g_value_set_uchar(value, static_cast<guchar>(source.ToNumber().Uint32Value())); return;
		case G_TYPE_INT: g_value_set_int(value, source.ToNumber().Int32Value()); return;
		case G_TYPE_UINT: g_value_set_uint(value, source.ToNumber().Uint32Value()); return;
		case G_TYPE_LONG: g_value_set_long(value, static_cast<glong>(source.ToNumber().Int64Value())); return;
		case G_TYPE_ULONG: g_value_set_ulong(value, static_cast<gulong>(source.ToNumber().Int64Value())); return;
		case G_TYPE_INT64: g_value_set_int64(value, source.ToNumber().Int64Value()); return;
		case G_TYPE_UINT64: g_value_set_uint64(value, static_cast<guint64>(source.ToNumber().Int64Value())); return;
		case G_TYPE_FLOAT: g_value_set_float(value, source.ToNumber().FloatValue()); return;
		case G_TYPE_DOUBLE: g_value_set_double(value, source.ToNumber().DoubleValue()); return;
		case G_TYPE_ENUM: g_value_set_enum(value, source.ToNumber().Int32Value()); return;
		case G_TYPE_FLAGS: g_value_set_flags(value, source.ToNumber().Uint32Value()); return;
		case G_TYPE_STRING:
			if (source.IsNull() || source.IsUndefined())
				g_value_set_string(value, nullptr);
			else
				g_value_set_string(value, source.ToString().Utf8Value().c_str());
			return;
		case G_TYPE_OBJECT:
		case G_TYPE_INTERFACE:
			g_value_set_object(value, unwrap_object(source, type, type_description(type).c_str(), true));
			return;
		case G_TYPE_BOXED: {
			if (type == G_TYPE_STRV) {
				Napi::Array array = source.As<Napi::Array>();
				std::vector<std::string> strings;
				std::vector<char *> pointers;
				for (uint32_t i = 0; i < array.Length(); i++)
					strings.push_back(array.Get(i).ToString().Utf8Value());
				for (auto &string : strings)
					pointers.push_back(string.data());
				pointers.push_back(nullptr);
				g_value_set_boxed(value, pointers.data());
				return;
			}
			g_value_set_boxed(value, unwrap_record(source, type, type_description(type).c_str(), true));
			return;
		}
		default: throw Napi::TypeError::New(env, "Cannot convert a JS value to " + type_description(type));
	}
}

/** Read a GObject property through its GValue. */
inline Napi::Value get_property(Napi::Value self, const char *name) {
	auto *object = unwrap_object<GObject>(self, G_TYPE_OBJECT, "GObject.Object");
	GParamSpec *spec = g_object_class_find_property(G_OBJECT_GET_CLASS(object), name);
	if (!spec)
		throw Napi::TypeError::New(self.Env(), std::string("No property named ") + name);
	GValue value = G_VALUE_INIT;
	g_value_init(&value, spec->value_type);
	g_object_get_property(object, name, &value);
	Napi::Value result = value_to_js(self.Env(), &value);
	g_value_unset(&value);
	return result;
}

/** Write a GObject property through its GValue. */
inline void set_property(Napi::Value self, const char *name, Napi::Value source) {
	auto *object = unwrap_object<GObject>(self, G_TYPE_OBJECT, "GObject.Object");
	GParamSpec *spec = g_object_class_find_property(G_OBJECT_GET_CLASS(object), name);
	if (!spec)
		throw Napi::TypeError::New(self.Env(), std::string("No property named ") + name);
	GValue value = G_VALUE_INIT;
	g_value_init(&value, spec->value_type);
	try {
		value_from_js(source, &value);
	} catch (...) {
		g_value_unset(&value);
		throw;
	}
	g_object_set_property(object, name, &value);
	g_value_unset(&value);
}

// --- callbacks -----------------------------------------------------------------

/** When C may call a callback: during the call, once, until its destroy notify, or for the process lifetime. */
enum class Scope { Call, Async, Notified, Forever };

/** A JS function that C calls through a generated trampoline, passed as the callback's user data. */
struct JsCallback {
	napi_env env;
	Scope scope;
	napi_ref function = nullptr;
	/** The first exception a `Call` scoped callback threw, rethrown to its caller. */
	napi_ref error = nullptr;

	JsCallback(Napi::Function value, Scope scope) : env(value.Env()), scope(scope) {
		napi_create_reference(env, value, 1, &function);
		if (scope == Scope::Async)
			call_quietly(env, runtime(env).hold_loop);
	}

	JsCallback(const JsCallback &) = delete;
	JsCallback &operator=(const JsCallback &) = delete;

	~JsCallback() {
		if (!on_main_thread())
			return;
		if (scope == Scope::Async)
			call_quietly(env, runtime(env).release_loop);
		napi_delete_reference(env, function);
		if (error)
			napi_delete_reference(env, error);
	}

	/** Call the function, returning an empty value if it threw. */
	Napi::Value call(const std::vector<napi_value> &args) {
		if (error)
			return Napi::Value();
		napi_value target, receiver, result;
		napi_get_reference_value(env, function, &target);
		napi_get_undefined(env, &receiver);
		if (napi_call_function(env, receiver, target, args.size(), args.data(), &result) == napi_ok)
			return Napi::Value(env, result);
		napi_value exception;
		napi_get_and_clear_last_exception(env, &exception);
		fail(exception);
		return Napi::Value();
	}

	/** Keep an exception for a `Call` scoped callback's caller, or report it as uncaught. */
	void fail(napi_value exception) {
		if (scope != Scope::Call) {
			napi_fatal_exception(env, exception);
			return;
		}
		if (!error)
			napi_create_reference(env, exception, 1, &error);
	}
};

/** A callback calling `value`, or null when `value` is null or undefined and the parameter is `nullable`. */
inline std::unique_ptr<JsCallback> new_callback(Napi::Value value, Scope scope, const char *name, bool nullable) {
	if (nullable && (value.IsNull() || value.IsUndefined()))
		return nullptr;
	if (!value.IsFunction())
		throw Napi::TypeError::New(value.Env(), std::string("Expected a function for '") + name + "'");
	return std::make_unique<JsCallback>(value.As<Napi::Function>(), scope);
}

/** Throw the exception a `Call` scoped callback's function threw, once the C call it was passed to returns. */
inline void rethrow(JsCallback *callback) {
	if (!callback || !callback->error)
		return;
	napi_value exception;
	napi_get_reference_value(callback->env, callback->error, &exception);
	throw Napi::Error(callback->env, exception);
}

/** Run a trampoline's `body` in a handle scope, then free an `Async` scoped callback. */
template <typename Body> void invoke(JsCallback *callback, Body body) {
	if (!on_main_thread()) {
		if (environment.alive)
			g_critical(
				"girbind: a callback was called on a thread other than the main thread; its JS function was skipped"
			);
		return;
	}
	{
		Napi::HandleScope scope(callback->env);
		try {
			body(Napi::Env(callback->env));
		} catch (const Napi::Error &error) {
			callback->fail(error.Value());
		}
	}
	if (callback->scope == Scope::Async)
		delete callback;
}

/** The destroy notify of a `Notified` scoped callback, which frees it on the main thread. */
inline void destroy_callback(gpointer data) {
	auto *callback = static_cast<JsCallback *>(data);
	if (on_main_thread() || !environment.alive) {
		delete callback;
		return;
	}
	g_idle_add(
		[](gpointer data) -> gboolean {
			delete static_cast<JsCallback *>(data);
			return G_SOURCE_REMOVE;
		},
		callback
	);
}

// --- asynchronous calls --------------------------------------------------------

/** A pending call to an asynchronous function: the promise it settles, and what it keeps alive until then. */
struct AsyncCall {
	napi_env env;
	Napi::Promise::Deferred deferred;
	/** The AbortSignal passed for the call's cancellable, if any. */
	Napi::ObjectReference signal;
	Napi::FunctionReference unwatch;
	/** A cancellable created for `signal`, owned by the call. */
	GObject *cancellable = nullptr;
	std::vector<Napi::Reference<Napi::Value>> values;
	std::vector<std::shared_ptr<void>> storage;

	explicit AsyncCall(Napi::Env env) : env(env), deferred(Napi::Promise::Deferred::New(env)) {
		call_quietly(env, runtime(env).hold_loop);
	}

	AsyncCall(const AsyncCall &) = delete;
	AsyncCall &operator=(const AsyncCall &) = delete;

	~AsyncCall() {
		if (!unwatch.IsEmpty())
			call_quietly(env, unwatch);
		if (cancellable)
			g_object_unref(cancellable);
		call_quietly(env, runtime(env).release_loop);
	}

	/** A new `T` that lives until the call settles, for arguments C may read after the call returns. */
	template <typename T> T &store() {
		auto value = std::make_shared<T>();
		storage.push_back(value);
		return *value;
	}

	/** Keep `value` alive until the call settles. */
	void keep(Napi::Value value) {
		values.push_back(Napi::Persistent(value));
	}
};

/** Cancel `cancellable`, which the call then owns, when the AbortSignal `signal` aborts. */
inline void watch_abort(AsyncCall *call, Napi::Value signal, GObject *cancellable, void (*cancel)(GObject *)) {
	Napi::Env env = signal.Env();
	call->cancellable = cancellable;
	Napi::Function listener =
		Napi::Function::New(env, [cancellable, cancel](const Napi::CallbackInfo &) { cancel(cancellable); });
	call->unwatch = Napi::Persistent(runtime(env).on_abort.Call({signal, listener}).As<Napi::Function>());
	call->signal = Napi::Persistent(signal.As<Napi::Object>());
}

/** Resolve a call's promise with what `convert` returns, or reject it with what it throws or the abort reason. */
template <typename Convert> void settle(AsyncCall *call, Convert convert) {
	if (!on_main_thread())
		return;
	std::unique_ptr<AsyncCall> owned(call);
	Napi::Env env(call->env);
	Napi::HandleScope scope(env);
	try {
		call->deferred.Resolve(convert(env));
	} catch (const Napi::Error &error) {
		Napi::Value reason = error.Value();
		if (!call->signal.IsEmpty() && call->signal.Value().Get("aborted").ToBoolean())
			reason = call->signal.Value().Get("reason");
		call->deferred.Reject(reason);
	}
}

} // namespace girbind
