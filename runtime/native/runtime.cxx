#include <atomic>
#include <girbind.hxx>

namespace {

girbind::Handle *expect_handle(const Napi::CallbackInfo &info) {
	girbind::Handle *handle = girbind::handle_from_external(info[0]);
	if (!handle || !handle->pointer)
		throw Napi::TypeError::New(info.Env(), "Expected a live girbind handle");
	return handle;
}

/** The address of a handle's native value, used as the wrapper identity key. */
Napi::Value address(const Napi::CallbackInfo &info) {
	return Napi::Number::New(
		info.Env(), static_cast<double>(reinterpret_cast<uintptr_t>(expect_handle(info)->pointer))
	);
}

/** The GType names of an object handle's instance and its ancestors, most derived first. */
Napi::Value type_chain(const Napi::CallbackInfo &info) {
	Napi::Env env = info.Env();
	girbind::Handle *handle = expect_handle(info);
	Napi::Array chain = Napi::Array::New(env);
	uint32_t index = 0;
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
	g_object_weak_ref(
		G_OBJECT(expect_handle(info)->pointer), [](gpointer, GObject *) { finalized_count++; }, nullptr
	);
	return info.Env().Undefined();
}

Napi::Value finalized(const Napi::CallbackInfo &info) {
	return Napi::Number::New(info.Env(), static_cast<double>(finalized_count.load()));
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
	exports.Set("abi", Napi::Number::New(env, girbind::abi_version));
	exports.Set("address", Napi::Function::New(env, address));
	exports.Set("typeChain", Napi::Function::New(env, type_chain));
	exports.Set("release", Napi::Function::New(env, release));
	exports.Set("watchFinalization", Napi::Function::New(env, watch_finalization));
	exports.Set("finalized", Napi::Function::New(env, finalized));
	return exports;
}

} // namespace

NODE_API_MODULE(girbind, Init)
