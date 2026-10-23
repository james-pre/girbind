// girbind runtime ABI, shared by the runtime addon and every generated addon.
//
// A wrapper object stores its native value as a type-tagged `External` under
// `Symbol.for("girbind.handle")`. Any addon can read a handle; wrappers for
// existing objects are created by the runtime's `wrap`, and classes are
// registered with the runtime by GType name so other addons can extend them.
// The layout of `Handle` is part of the ABI: change `abi_version` with it.

#pragma once

#include <glib-object.h>
#include <napi.h>
#include <string>

namespace girbind {

inline constexpr uint32_t abi_version = 1;

enum class Kind : uint32_t { Object, Boxed, Plain };

struct Handle {
	Kind kind;
	GType type;
	gpointer pointer;
};

inline constexpr napi_type_tag handle_tag = {0x6769726269e4d001, 0x9a3c5b7e21f04d8c};

inline void release(Handle *handle) {
	if (!handle->pointer)
		return;
	switch (handle->kind) {
		case Kind::Object: g_object_unref(handle->pointer); break;
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
	Napi::FunctionReference lookup;
	Napi::Reference<Napi::Symbol> key;
	Napi::Reference<Napi::Symbol> adopt;
};

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
		Napi::Persistent(abi.Get("lookup").As<Napi::Function>()),
		Napi::Persistent(abi.Get("handle").As<Napi::Symbol>()),
		Napi::Persistent(abi.Get("adopt").As<Napi::Symbol>()),
	});
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
};

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
	if (info.Length() >= 2 && info[0].StrictEquals(state.adopt.Value())) {
		handle = info[1];
	} else if (class_info->construct) {
		handle = class_info->construct(info);
	} else {
		throw Napi::TypeError::New(env, std::string(class_info->name) + " cannot be constructed directly");
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

/** Define a class extending `parent` and register it with the runtime under `type_name`. */
inline Napi::Function define_class(Napi::Env env, const ClassInfo &info, const char *type_name, Napi::Function parent) {
	napi_value constructor;
	napi_status status = napi_define_class(
		env, info.name, NAPI_AUTO_LENGTH, invoke_constructor, const_cast<ClassInfo *>(&info), 0, nullptr, &constructor
	);
	if (status != napi_ok)
		throw Napi::Error::New(env);
	Napi::Function cls(env, constructor);
	Napi::Function set_prototype_of =
		env.Global().Get("Object").As<Napi::Object>().Get("setPrototypeOf").As<Napi::Function>();
	set_prototype_of.Call({cls.Get("prototype"), parent.Get("prototype")});
	set_prototype_of.Call({cls, parent});
	runtime(env).register_class.Call({Napi::String::New(env, type_name), cls});
	return cls;
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

} // namespace girbind
