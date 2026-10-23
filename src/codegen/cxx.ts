/**
 * C++ N-API addon emitter.
 *
 * Each addon defines its classes natively in `$init`: GObject classes extend
 * their GIR parent (looked up in the runtime when it lives in another
 * namespace), and records extend the runtime's `GObject.Boxed`. Instance
 * members read `self` from `this` through the runtime ABI (`girbind.hxx`),
 * which checks the GType, so a member defined once works on every subclass
 * instance, including subclasses from other namespaces.
 *
 * The emitter is a set of generator functions: each `yield`s lines of C++ and
 * the top-level {@link generate} joins them. Emitted code is tab-indented.
 */

import type { Class, Field, Func, Namespace, Parameter, Property, ReturnValue, Struct, TypeRef } from '../ir.js';
import { camelCase, factoryName, functionExportNames, isSupported, methodName, primaryConstructor } from '../names.js';
import type { Repository } from '../parse.js';
import { type RecordType, shortName, TypeContext } from '../types.js';

type Lines = Generator<string, void, void>;

/** Indent a block of already-rendered lines by one tab. */
function* indent(...lines: string[]): Lines {
	for (const line of lines) yield line === '' ? '' : '\t' + line;
}

/** Delegate to `lines`, indenting each by one tab, and return its result. */
function* indented<T>(lines: Generator<string, T, void>): Generator<string, T, void> {
	let next = lines.next();
	while (!next.done) {
		yield next.value === '' ? '' : '\t' + next.value;
		next = lines.next();
	}
	return next.value;
}

/** Classes the addon binds: GObject classes only (fundamental types are not GObjects), each after its parent. */
export function boundClasses(ctx: TypeContext): Class[] {
	const classes = ctx.ns.classes.filter(cls => ctx.isGObjectClass(cls));
	const ordered: Class[] = [];
	const placed = new Set<Class>();
	const place = (cls: Class) => {
		if (placed.has(cls)) return;
		placed.add(cls);
		const parent = cls.parent ? ctx.ourClass(cls.parent) : undefined;
		if (parent && classes.includes(parent)) place(parent);
		ordered.push(cls);
	};
	for (const cls of classes) place(cls);
	return ordered;
}

/** Records the addon binds: those with a boxed GType or a plain-data layout. */
export function boundRecords(ctx: TypeContext): RecordType[] {
	return ctx.ns.records.map(record => ctx.recordType(record.name)).filter((type): type is RecordType => !!type);
}

/** A class or record the addon defines natively. */
export interface Owner {
	name: string;
	cName: string;
	qualified: string;
	members: Class | Struct;
	/** The constructor bound to JS `new`, if any. */
	primary?: Func;
	/** Declaration of `self`, read and type-checked from `this`. */
	self: string;
	record?: RecordType;
}

export function classOwner(ctx: TypeContext, cls: Class): Owner {
	const type = ctx.objectType(cls.name)!;
	const primary = primaryConstructor(cls.constructors);
	return {
		name: cls.name,
		cName: cls.cName,
		qualified: type.qualified,
		members: cls,
		primary: primary && isSupported(primary) ? primary : undefined,
		self: `${cls.cName}* self = girbind::unwrap_object<${cls.cName}>(info.This(), ${ctx.gtypeExpression(type)}, "${type.qualified}");`,
	};
}

export function recordOwner(ctx: TypeContext, type: RecordType): Owner {
	const { record } = type;
	const primary = record.constructors.find(c => c.name === 'new');
	return {
		name: record.name,
		cName: record.cName,
		qualified: type.qualified,
		members: record,
		primary: primary && isSupported(primary) ? primary : undefined,
		self: `${record.cName}* self = girbind::unwrap_record<${record.cName}>(info.This(), ${ctx.recordGType(type)}, "${type.qualified}");`,
		record: type,
	};
}

/** Whether a record can be created zeroed, without a constructor: its layout is public. */
export function zeroConstructible(owner: Owner): boolean {
	return !!owner.record && !owner.record.record.isOpaque && owner.record.record.fields.length > 0;
}

function hasConstructor(owner: Owner): boolean {
	return !!owner.primary || zeroConstructible(owner);
}

/** Reference-counting and freeing methods, which would unbalance the reference a wrapper owns. */
const lifecycleMethods = new Set(['ref', 'unref', 'ref_sink', 'free']);

export const methods = (owner: Owner) =>
	owner.members.methods.filter(func => isSupported(func) && !lifecycleMethods.has(func.name));
export const statics = (owner: Owner) => owner.members.staticMethods.filter(isSupported);
/** The constructor bound to JS `new`: `new` (or the first constructor) for classes, only `new` for records. */
function primaryOf(owner: Owner): Func | undefined {
	const { constructors } = owner.members;
	return owner.record ? constructors.find(c => c.name === 'new') : primaryConstructor(constructors);
}

/** Constructors other than the primary, exposed as static factories. */
export const factories = (owner: Owner) =>
	owner.members.constructors.filter(c => c !== primaryOf(owner) && isSupported(c));

/** JS names of an owner's methods and statics, which shadow properties and fields of the same name. */
function memberNames(owner: Owner): Set<string> {
	return new Set([...methods(owner), ...statics(owner), ...factories(owner)].map(methodName));
}

/** Properties exposed as accessors: those not shadowed by a method of the same JS name. */
export function properties(owner: Owner): Property[] {
	if (owner.record) return [];
	const taken = memberNames(owner);
	return (owner.members as Class).properties.filter(p => !taken.has(propJsName(p)));
}

/** How a record field converts, or undefined when it is not exposed. */
type FieldKind = 'boolean' | 'number' | RecordType;

function fieldKind(ctx: TypeContext, field: Field): FieldKind | undefined {
	if (field.hidden || field.type.isArray || !field.readable || field.type.cType.includes('*')) return undefined;
	const t = field.type.girType;
	if (t === 'gboolean') return 'boolean';
	if (ctx.enumeration(t) || ctx.isPrimitive(t)) return 'number';
	const record = ctx.recordType(t);
	if (record && !record.record.isOpaque) return record;
	return undefined;
}

/** Record fields exposed as accessors. */
export function fields(ctx: TypeContext, owner: Owner): Field[] {
	if (!owner.record) return [];
	const taken = memberNames(owner);
	return owner.record.record.fields.filter(field => fieldKind(ctx, field) && !taken.has(camelCase(field.name)));
}

function propId(p: Property): string {
	return p.name.replace(/-/g, '_');
}

function propJsName(p: Property): string {
	return p.name.replace(/-/g, '_').replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

/** Whether a parameter is the trailing `GError**` that GIRs without `throws` still list. */
function isErrorParam(p: Parameter): boolean {
	return p.type.cType.replace(/\s/g, '') === 'GError**';
}

function errorParam(func: Func): string | undefined {
	return func.throws || func.parameters.some(isErrorParam) ? 'error' : undefined;
}

/** Lines that throw when `err` is set after a C call. */
function* errorCheck(err: string): Lines {
	yield `if (${err}) {`;
	yield `\tNapi::Error js_error = Napi::Error::New(env, ${err}->message);`;
	yield `\tg_error_free(${err});`;
	yield '\tthrow js_error;';
	yield '}';
}

/** Build a C call expression: `<lhs>(<params>[, &error]);`. */
function callExpr(lhs: string, cppParams: string[], err: string | undefined): string {
	let call = `${lhs}(${cppParams.join(', ')}`;
	if (err) call += (cppParams.length ? ', &' : '&') + err;
	return call + ');';
}

/** A new handle for a record at `pointer`, copying it unless `owned`. */
function recordHandle(ctx: TypeContext, type: RecordType, pointer: string, owned: boolean): string {
	const gtype = ctx.recordGType(type);
	return type.binding === 'boxed'
		? `girbind::boxed_handle(env, ${gtype}, ${pointer}, ${owned})`
		: `girbind::plain_handle(env, ${gtype}, ${pointer}, sizeof(${type.record.cName}), ${owned})`;
}

/** The wrapper for a record at `pointer`, copying it unless `owned`. */
function wrapRecord(ctx: TypeContext, type: RecordType, pointer: string, owned: boolean): string {
	const gtype = ctx.recordGType(type);
	return type.binding === 'boxed'
		? `girbind::wrap_boxed(env, ${gtype}, ${pointer}, ${owned})`
		: `girbind::wrap_plain(env, ${gtype}, ${pointer}, sizeof(${type.record.cName}), ${owned})`;
}

/** The GType name the runtime registers an owner's class under. */
function registeredName(ctx: TypeContext, owner: Owner): string {
	if (owner.record) {
		return owner.record.binding === 'plain'
			? `girbind+${owner.cName}`
			: (owner.record.record.typeName ?? owner.cName);
	}
	return ctx.typeName(ctx.objectType(owner.name)!);
}

// --- members ----------------------------------------------------------------

function* construct(ctx: TypeContext, owner: Owner): Lines {
	yield `Napi::Value construct_${owner.name}(const Napi::CallbackInfo& info) {`;
	yield '\tNapi::Env env = info.Env();';
	const func = owner.primary;
	if (!func) {
		yield `\t${owner.cName} zero = {};`;
		yield `\treturn ${recordHandle(ctx, owner.record!, '&zero', false)};`;
		yield '}';
		yield '';
		return;
	}
	const cppParams: string[] = [];
	yield* indent(...emitParams(ctx, func, [], cppParams));
	const err = errorParam(func);
	if (err) yield `\tGError* ${err} = NULL;`;
	yield `\t${callExpr(`gpointer handle = (gpointer)${func.cName}`, cppParams, err)}`;
	if (err) yield* indent(...errorCheck(err));
	yield '\tif (!handle) {';
	yield `\t\tthrow Napi::Error::New(env, "${func.cName} returned NULL");`;
	yield '\t}';
	const owned = func.returnValue.transfer !== 'none';
	yield owner.record
		? `\treturn ${recordHandle(ctx, owner.record, 'handle', owned)};`
		: `\treturn girbind::object_handle(env, handle, ${owned});`;
	yield '}';
	yield '';
}

function* factory(ctx: TypeContext, owner: Owner, func: Func): Lines {
	yield `Napi::Value ${owner.name}_factory_${factoryName(func)}(const Napi::CallbackInfo& info) {`;
	yield '\tNapi::Env env = info.Env();';
	yield* indent(...callAndReturn(ctx, func, []));
	yield '}';
	yield '';
}

/** Whether a method returns its own instance pointer, as builder-style record methods such as `init` do. */
function mayReturnSelf(ctx: TypeContext, owner: Owner, func: Func): boolean {
	const rv = func.returnValue;
	return !!owner.record && rv.transfer === 'none' && ctx.qualify(rv.type.girType) === owner.qualified;
}

/** The `self` argument, as a new reference or copy when the method takes ownership of its instance. */
function selfArgument(ctx: TypeContext, owner: Owner, func: Func): string {
	const instance = func.parameters.find(p => p.isInstance);
	if (!instance || instance.transfer === 'none') return 'self';
	if (!owner.record) return `(${owner.cName}*)g_object_ref(self)`;
	return ownedRecord(ctx, owner.record, 'self');
}

/** A new copy of the record at `pointer` that the callee will own. */
function ownedRecord(ctx: TypeContext, type: RecordType, pointer: string): string {
	const cName = type.record.cName;
	return type.binding === 'boxed'
		? `(${cName}*)(${pointer} ? g_boxed_copy(${ctx.recordGType(type)}, ${pointer}) : NULL)`
		: `(${cName}*)(${pointer} ? memcpy(g_malloc(sizeof(${cName})), ${pointer}, sizeof(${cName})) : NULL)`;
}

/** An in argument the callee takes ownership of (`transfer full`), as its own reference or copy. */
function ownedArgument(ctx: TypeContext, p: Parameter, local: string, expression: string): string {
	if (p.transfer === 'none') return expression;
	const t = p.type.girType;
	const cast = p.type.cType ? `(${p.type.cType})` : '';
	if (ctx.objectType(t)) return `${cast}(${local} ? g_object_ref(${local}) : NULL)`;
	const record = ctx.recordType(t);
	if (record && !isScalarCType(p.type.cType)) return `${cast}${ownedRecord(ctx, record, local)}`;
	const isString = t === 'utf8' || t === 'filename';
	if ((p.type.isArray && ctx.arrayKind(p.type) === 'strv') || (isString && /\*\s*\*/.test(p.type.cType))) {
		return `${cast}g_strdupv((gchar**)${local})`;
	}
	if (isString) return `${cast}g_strdup(${local})`;
	return expression;
}

function* method(ctx: TypeContext, owner: Owner, func: Func): Lines {
	yield `Napi::Value ${owner.name}_${methodName(func)}(const Napi::CallbackInfo& info) {`;
	yield '\tNapi::Env env = info.Env();';
	yield `\t${owner.self}`;
	yield* indent(...callAndReturn(ctx, func, [selfArgument(ctx, owner, func)], mayReturnSelf(ctx, owner, func)));
	yield '}';
	yield '';
}

function* staticMethod(ctx: TypeContext, owner: Owner, func: Func): Lines {
	yield `Napi::Value ${owner.name}_static_${methodName(func)}(const Napi::CallbackInfo& info) {`;
	yield '\tNapi::Env env = info.Env();';
	yield* indent(...callAndReturn(ctx, func, []));
	yield '}';
	yield '';
}

function* standalone(ctx: TypeContext, func: Func): Lines {
	yield `Napi::Value Wrap_${func.cName}(const Napi::CallbackInfo& info) {`;
	yield '\tNapi::Env env = info.Env();';
	yield* indent(...callAndReturn(ctx, func, []));
	yield '}';
	yield '';
}

/** Find the instance method implementing a property accessor, searching this namespace's hierarchy from `cls`. */
function accessorMethod(ctx: TypeContext, cls: Class, methodGirName: string | undefined): Func | undefined {
	if (!methodGirName) return undefined;
	for (
		let current: Class | undefined = cls;
		current;
		current = current.parent ? ctx.ourClass(current.parent) : undefined
	) {
		const found = current.methods.find(m => m.name === methodGirName);
		if (found) return found;
	}
	return undefined;
}

/** Parameters of a function other than `self` and the trailing `GError**`. */
function valueParams(func: Func): Parameter[] {
	return func.parameters.filter(sp => !sp.isInstance && !isErrorParam(sp));
}

function getterMethod(ctx: TypeContext, cls: Class, p: Property): Func | undefined {
	const candidate = accessorMethod(ctx, cls, p.getter);
	return candidate && isSupported(candidate) && !valueParams(candidate).length ? candidate : undefined;
}

function setterMethod(ctx: TypeContext, cls: Class, p: Property): Func | undefined {
	const candidate = accessorMethod(ctx, cls, p.setter);
	return candidate && isSupported(candidate) && valueParams(candidate).length === 1 ? candidate : undefined;
}

export function hasSetter(ctx: TypeContext, cls: Class, p: Property): boolean {
	if (!p.writable) return false;
	return !!setterMethod(ctx, cls, p) || !p.constructOnly;
}

function* propertyAccessors(ctx: TypeContext, owner: Owner, p: Property): Lines {
	const cls = owner.members as Class;
	const getter = getterMethod(ctx, cls, p);
	const setter = setterMethod(ctx, cls, p);

	if (p.readable) {
		yield `Napi::Value ${owner.name}_get_${propId(p)}(const Napi::CallbackInfo& info) {`;
		yield '\tNapi::Env env = info.Env();';
		if (getter) {
			yield `\t${owner.self}`;
			const err = errorParam(getter);
			if (err) yield `\tGError* ${err} = NULL;`;
			yield `\t${callExpr(`auto value = ${getter.cName}`, [`(${getter.parameters[0]?.type.cType || `${cls.cName}*`})self`], err)}`;
			if (err) yield* indent(...errorCheck(err));
			yield* indent(
				...convertToJs(ctx, getter.returnValue.type, getter.returnValue.transfer, 'value', v => `return ${v};`)
			);
		} else {
			yield '\t(void)env;';
			yield `\treturn girbind::get_property(info.This(), "${p.name}");`;
		}
		yield '}';
		yield '';
	}

	if (!hasSetter(ctx, cls, p)) return;
	yield `Napi::Value ${owner.name}_set_${propId(p)}(const Napi::CallbackInfo& info) {`;
	yield '\tNapi::Env env = info.Env();';
	if (setter) {
		yield `\t${owner.self}`;
		const valueParam = valueParams(setter)[0];
		const value = ownedArgument(
			ctx,
			valueParam,
			'value',
			yield* indented(fromJs(ctx, valueParam, 'info[0]', 'value'))
		);
		const err = errorParam(setter);
		if (err) yield `\tGError* ${err} = NULL;`;
		yield `\t${callExpr(setter.cName, [`(${setter.parameters[0]?.type.cType || `${cls.cName}*`})self`, value], err)}`;
		if (err) yield* indent(...errorCheck(err));
	} else {
		yield `\tgirbind::set_property(info.This(), "${p.name}", info[0]);`;
	}
	yield '\treturn env.Undefined();';
	yield '}';
	yield '';
}

function* fieldAccessors(ctx: TypeContext, owner: Owner, field: Field): Lines {
	const kind = fieldKind(ctx, field)!;
	yield `Napi::Value ${owner.name}_get_${field.name}(const Napi::CallbackInfo& info) {`;
	yield '\tNapi::Env env = info.Env();';
	yield `\t${owner.self}`;
	if (kind === 'boolean') yield `\treturn Napi::Boolean::New(env, self->${field.name});`;
	else if (kind === 'number') yield `\treturn Napi::Number::New(env, static_cast<double>(self->${field.name}));`;
	else yield `\treturn ${wrapRecord(ctx, kind, `&self->${field.name}`, false)};`;
	yield '}';
	yield '';

	if (!field.writable) return;
	yield `Napi::Value ${owner.name}_set_${field.name}(const Napi::CallbackInfo& info) {`;
	yield '\tNapi::Env env = info.Env();';
	yield `\t${owner.self}`;
	const parameter: Parameter = {
		name: field.name,
		type: field.type,
		transfer: 'none',
		nullable: false,
		direction: 'in',
		isInstance: false,
		callerAllocates: false,
	};
	const value = yield* indented(fromJs(ctx, parameter, 'info[0]', 'value'));
	yield `\tself->${field.name} = ${value};`;
	yield '\treturn env.Undefined();';
	yield '}';
	yield '';
}

/** Accessors as `[JS name, getter, setter]`, with `nullptr` for a missing half. */
function accessorEntries(ctx: TypeContext, owner: Owner): [string, string, string][] {
	const entries: [string, string, string][] = [];
	for (const p of properties(owner)) {
		entries.push([
			propJsName(p),
			p.readable ? `${owner.name}_get_${propId(p)}` : 'nullptr',
			hasSetter(ctx, owner.members as Class, p) ? `${owner.name}_set_${propId(p)}` : 'nullptr',
		]);
	}
	for (const field of fields(ctx, owner)) {
		entries.push([
			camelCase(field.name),
			`${owner.name}_get_${field.name}`,
			field.writable ? `${owner.name}_set_${field.name}` : 'nullptr',
		]);
	}
	return entries;
}

function* ownerDef(ctx: TypeContext, owner: Owner): Lines {
	if (hasConstructor(owner)) yield* construct(ctx, owner);
	for (const f of factories(owner)) yield* factory(ctx, owner, f);
	for (const f of statics(owner)) yield* staticMethod(ctx, owner, f);
	for (const f of methods(owner)) yield* method(ctx, owner, f);
	for (const p of properties(owner)) yield* propertyAccessors(ctx, owner, p);
	for (const field of fields(ctx, owner)) yield* fieldAccessors(ctx, owner, field);
	yield* ownerDefinition(ctx, owner);
}

/** The function defining a class on `parent`, with its members, and registering it with the runtime. */
function* ownerDefinition(ctx: TypeContext, owner: Owner): Lines {
	const constructor = hasConstructor(owner) ? `construct_${owner.name}` : 'nullptr';
	yield `const girbind::ClassInfo info_${owner.name} = {"${owner.name}", ${constructor}};`;
	const accessors = accessorEntries(ctx, owner);
	for (const [name, get, set] of accessors) {
		yield `const girbind::Accessor ${owner.name}_accessor_${name} = {${get}, ${set}};`;
	}
	yield '';
	yield `Napi::Function define_${owner.name}(Napi::Env env, Napi::Function parent) {`;
	yield `\tNapi::Function cls = girbind::define_class(env, info_${owner.name}, "${registeredName(ctx, owner)}", parent);`;
	yield '\tNapi::Object prototype = cls.Get("prototype").As<Napi::Object>();';
	for (const f of methods(owner)) {
		yield `\tgirbind::define_method(prototype, "${methodName(f)}", ${owner.name}_${methodName(f)});`;
	}
	for (const [name] of accessors) {
		yield `\tgirbind::define_accessor(prototype, "${name}", ${owner.name}_accessor_${name});`;
	}
	for (const f of factories(owner)) {
		yield `\tgirbind::define_method(cls, "${factoryName(f)}", ${owner.name}_factory_${factoryName(f)});`;
	}
	for (const f of statics(owner)) {
		yield `\tgirbind::define_method(cls, "${methodName(f)}", ${owner.name}_static_${methodName(f)});`;
	}
	yield '\treturn cls;';
	yield '}';
	yield '';
}

// --- call + conversion ------------------------------------------------------

/** A non-pointer C type of a type GIR does not describe, such as `GPid`, carried as a number. */
function isScalarCType(cType: string): boolean {
	return !!cType && !cType.includes('*') && !['void', 'gpointer', 'gconstpointer'].includes(cType);
}

/** The `Napi::Number` accessor that preserves a numeric GIR type's range. */
function numberAccessor(girType: string): string {
	if (girType.includes('double') || girType.includes('float')) return 'DoubleValue()';
	if (/64|size|ptr|offset|GType|long/.test(girType)) return 'Int64Value()';
	return 'Int32Value()';
}

/**
 * Emit parameter extraction, the C call (with error handling) and the JS return
 * for a function. `leading` is prepended to the call args (`self` for methods).
 */
function* callAndReturn(ctx: TypeContext, func: Func, leading: string[], mayReturnSelf = false): Lines {
	const cppParams: string[] = [];
	const outParams = yield* emitParams(ctx, func, leading, cppParams);

	const err = errorParam(func);
	if (err) yield `GError* ${err} = NULL;`;

	const rv = func.returnValue;
	let resultVar: string | null = null;
	if (rv.type.girType === 'none') {
		yield callExpr(`${func.cName}`, cppParams, err);
	} else {
		resultVar = 'result';
		yield callExpr(`auto ${resultVar} = ${func.cName}`, cppParams, err);
	}

	if (err) yield* errorCheck(err);
	if (mayReturnSelf && resultVar && !outParams.length) {
		yield `if ((gconstpointer)${resultVar} == (gconstpointer)self) return info.This();`;
	}
	yield* emitResult(ctx, func, resultVar, outParams);
}

/**
 * Convert a C value `varName` (of GIR type `type`, with `transfer` ownership)
 * into a `Napi::Value`, yielding an expression via `emit(expr)`. Shared by
 * function returns, property getters and array elements. Does not itself emit a
 * `return`; the caller decides what to do with the produced value.
 */
function* convertToJs(
	ctx: TypeContext,
	type: TypeRef,
	transfer: ReturnValue['transfer'],
	varName: string,
	emit: (valueExpr: string) => string
): Lines {
	const t = type.girType;

	if (type.isArray) {
		yield* convertArrayToJs(ctx, type, transfer, varName, emit);
		return;
	}
	if ((t === 'gboolean' || ctx.enumeration(t) || ctx.isPrimitive(t)) && type.cType.includes('*')) {
		yield `// TODO: unannotated array of "${t}"`;
		yield emit('env.Null()');
		return;
	}
	if (t === 'utf8' || t === 'filename') {
		yield `Napi::String ${varName}_js = Napi::String::New(env, ${varName} ? (const char*)${varName} : "");`;
		if (transfer !== 'none') yield `g_free((gpointer)${varName});`;
		yield emit(`${varName}_js`);
		return;
	}
	if (t === 'gboolean') {
		yield emit(`Napi::Boolean::New(env, ${varName})`);
		return;
	}
	if (ctx.enumeration(t)) {
		yield emit(`Napi::Number::New(env, static_cast<int32_t>(${varName}))`);
		return;
	}
	const record = ctx.recordType(t);
	if (record) {
		// A by-value record is a local struct (an out parameter); copy it.
		const byValue = isScalarCType(type.cType);
		const pointer = byValue ? `&${varName}` : `(gconstpointer)${varName}`;
		yield emit(wrapRecord(ctx, record, pointer, !byValue && transfer !== 'none'));
		return;
	}
	if (ctx.isPrimitive(t) || t === 'GLib.Quark' || isScalarCType(type.cType)) {
		yield emit(`Napi::Number::New(env, static_cast<double>(${varName}))`);
		return;
	}
	if (t === 'GLib.Bytes') {
		yield* bytesToJs(varName, transfer, emit);
		return;
	}
	if (ctx.objectType(t)) {
		yield emit(`girbind::wrap_object(env, (gpointer)${varName}, ${transfer !== 'none'})`);
		return;
	}
	// Boxed or unknown type: hand back an opaque External, reffed when we own it so it outlives the JS handle.
	yield foreignToJs(ctx.cBaseType(type), varName, transfer, emit);
}

const foreignToJs = (base: string, varName: string, transfer: ReturnValue['transfer'], emit: (e: string) => string) =>
	`${emit(
		transfer !== 'none'
			? `Napi::External<${base}>::New(env, (${base}*)${varName}, [](Napi::Env, ${base}* p) { if (p && G_IS_OBJECT(p)) g_object_unref(p); })`
			: `Napi::External<${base}>::New(env, (${base}*)${varName})`
	)}`;

function* bytesToJs(varName: string, transfer: ReturnValue['transfer'], emit: (e: string) => string): Lines {
	yield `gsize ${varName}_len = 0;`;
	yield `gconstpointer ${varName}_data = g_bytes_get_data(${varName}, &${varName}_len);`;
	yield `Napi::Buffer<uint8_t> ${varName}_buf = Napi::Buffer<uint8_t>::Copy(env, static_cast<const uint8_t*>(${varName}_data), ${varName}_len);`;
	if (transfer !== 'none') yield `g_bytes_unref(${varName});`;
	yield emit(`${varName}_buf`);
}

/** Convert a C array (`char**` / `GPtrArray*`) to a JS array. */
function* convertArrayToJs(
	ctx: TypeContext,
	type: TypeRef,
	transfer: ReturnValue['transfer'],
	varName: string,
	emit: (e: string) => string
): Lines {
	const kind = ctx.arrayKind(type);

	if (kind === 'strv') {
		yield `Napi::Array ${varName}_js = Napi::Array::New(env);`;
		yield `if (${varName}) {`;
		yield `\tfor (gsize i = 0; ${varName}[i] != NULL; i++) {`;
		yield `\t\t${varName}_js.Set(static_cast<uint32_t>(i), Napi::String::New(env, ${varName}[i]));`;
		yield '\t}';
		if (transfer !== 'none') yield `\tg_strfreev((gchar**)${varName});`;
		yield '}';
		yield emit(`${varName}_js`);
		return;
	}

	if (kind === 'ptrArray') {
		const elem = type.elementType ?? '';
		yield `Napi::Array ${varName}_js = Napi::Array::New(env);`;
		yield `if (${varName}) {`;
		yield `\tfor (guint i = 0; i < ${varName}->len; i++) {`;
		yield `\t\tgpointer ${varName}_item = g_ptr_array_index(${varName}, i);`;
		// Container transfer means elements are borrowed; element transfer none.
		const elemRecord = ctx.recordType(elem);
		if (ctx.objectType(elem)) {
			yield `\t\t${varName}_js.Set(i, girbind::wrap_object(env, ${varName}_item, false));`;
		} else if (elemRecord) {
			yield `\t\t${varName}_js.Set(i, ${wrapRecord(ctx, elemRecord, `${varName}_item`, false)});`;
		} else {
			const base = ctx.cBaseType({ girType: elem, cType: '', isArray: false });
			yield `\t\t${foreignToJs(base, `${varName}_item`, 'none', v => `${varName}_js.Set(i, ${v});`)}`;
		}
		yield '\t}';
		if (transfer !== 'none') yield `\tg_ptr_array_unref(${varName});`;
		yield '}';
		yield emit(`${varName}_js`);
		return;
	}

	yield `// TODO: convert array return of element type "${type.elementType ?? '?'}"`;
	yield emit('env.Null()');
}

/** An output parameter whose value is collected into the function result. */
interface OutParam {
	name: string;
	/** Key of this value in a multi-value result object. */
	key: string;
	type: TypeRef;
	transfer: ReturnValue['transfer'];
}

/**
 * Declare `local` and fill it from the JS value `source` for an input
 * parameter, returning the expression to pass to C. Throws a TypeError (as a
 * C++ exception) on a type mismatch.
 */
function* fromJs(ctx: TypeContext, p: Parameter, source: string, local: string): Generator<string, string, void> {
	const t = p.type.girType;
	function* expect(check: string, expected: string): Lines {
		yield `if (!${source}.${check}) {`;
		yield `\tthrow Napi::TypeError::New(env, "Expected ${expected} for '${p.name}'");`;
		yield '}';
	}
	const absent = `${source}.IsNull() || ${source}.IsUndefined()`;

	// A string array may appear as an <array> or as utf8 with a `char**` c:type.
	const isStrvParam =
		(p.type.isArray && ctx.arrayKind(p.type) === 'strv')
		|| ((t === 'utf8' || t === 'filename') && /\*\s*\*/.test(p.type.cType));

	if (isStrvParam) {
		// JS string[] -> NULL-terminated char**. Backing storage lives for the
		// duration of the wrapper call, which is all the C call needs.
		yield* expect('IsArray()', 'string[]');
		yield `Napi::Array ${local}_arr = ${source}.As<Napi::Array>();`;
		yield `std::vector<std::string> ${local}_store;`;
		yield `std::vector<const char*> ${local}_vec;`;
		yield `for (uint32_t i = 0; i < ${local}_arr.Length(); i++) {`;
		yield `\t${local}_store.push_back(${local}_arr.Get(i).As<Napi::String>().Utf8Value());`;
		yield '}';
		yield `for (auto& s : ${local}_store) ${local}_vec.push_back(s.c_str());`;
		yield `${local}_vec.push_back(NULL);`;
		yield `const char** ${local} = ${local}_vec.data();`;
		return p.type.cType ? `(${p.type.cType})${local}` : local;
	}

	if (p.type.isArray) {
		yield `// TODO: array parameter "${p.name}" of element type "${p.type.elementType ?? '?'}"`;
		return 'NULL';
	}

	if (t === 'utf8' || t === 'filename') {
		yield `std::string ${local}_str;`;
		yield `const char* ${local} = NULL;`;
		if (p.nullable) {
			yield `if (!(${absent})) {`;
			yield* indent(...expect('IsString()', 'string'));
			yield `\t${local}_str = ${source}.As<Napi::String>().Utf8Value();`;
			yield `\t${local} = ${local}_str.c_str();`;
			yield '}';
		} else {
			yield* expect('IsString()', 'string');
			yield `${local}_str = ${source}.As<Napi::String>().Utf8Value();`;
			yield `${local} = ${local}_str.c_str();`;
		}
		return p.type.cType ? `(${p.type.cType})${local}` : local;
	}
	if (t === 'gboolean') {
		yield* expect('IsBoolean()', 'boolean');
		yield `gboolean ${local} = ${source}.As<Napi::Boolean>().Value();`;
		return local;
	}
	if (ctx.enumeration(t)) {
		const ct = ctx.cType(p.type).replace(/\*$/, '').trim();
		yield* expect('IsNumber()', 'number');
		yield `${ct} ${local} = static_cast<${ct}>(${source}.As<Napi::Number>().Int32Value());`;
		return local;
	}
	const record = ctx.recordType(t);
	if (record) {
		const cName = record.record.cName;
		yield `${cName}* ${local} = girbind::unwrap_record<${cName}>(${source}, ${ctx.recordGType(record)}, "${record.qualified}", ${p.nullable});`;
		if (isScalarCType(p.type.cType)) return `*${local}`;
		return p.type.cType ? `(${p.type.cType})${local}` : local;
	}
	if (ctx.isPrimitive(t) || isScalarCType(p.type.cType)) {
		const ct = ctx.cType(p.type);
		yield* expect('IsNumber()', 'number');
		yield `${ct} ${local} = static_cast<${ct}>(${source}.As<Napi::Number>().${numberAccessor(t)});`;
		return local;
	}
	const object = ctx.objectType(t);
	if (object) {
		const base = ctx.cBaseType(p.type);
		yield `${base}* ${local} = girbind::unwrap_object<${base}>(${source}, ${ctx.gtypeExpression(object)}, "${object.qualified}", ${p.nullable});`;
		return local;
	}
	// Boxed or unknown type: accept an opaque External produced elsewhere.
	const base = ctx.cBaseType(p.type);
	yield `${base}* ${local} = NULL;`;
	if (p.nullable) {
		yield `if (!(${absent})) {`;
		yield* indent(...expect('IsExternal()', `external ${t}`));
		yield `\t${local} = ${source}.As<Napi::External<${base}>>().Data();`;
		yield '}';
	} else {
		yield* expect('IsExternal()', `external ${t}`);
		yield `${local} = ${source}.As<Napi::External<${base}>>().Data();`;
	}
	return local;
}

function* param(ctx: TypeContext, p: Parameter, index: number, cppParams: string[], outParams: OutParam[]): Lines {
	if (isErrorParam(p)) return;

	if (p.direction !== 'in') {
		// Allocate a local of the pointed-to type and pass its address. The C param
		// is `T*` (e.g. `gboolean*`, `FlatpakInstance**`), so the local is `T`:
		// strip exactly one pointer level from the c:type.
		const stripped = p.type.cType.replace(/\*\s*$/, '').trim() || ctx.cBaseType(p.type);
		const local = stripped === 'void' ? 'gpointer' : stripped;
		yield `${local} out_${p.name} = ${local.endsWith('*') || local === 'gpointer' ? 'NULL' : '{}'};`;
		cppParams.push(`&out_${p.name}`);
		outParams.push({ name: `out_${p.name}`, key: p.name, type: { ...p.type, cType: local }, transfer: p.transfer });
		return;
	}

	const local = `arg_${p.name}`;
	cppParams.push(ownedArgument(ctx, p, local, yield* fromJs(ctx, p, `info[${index}]`, local)));
}

/**
 * Emit extraction for all of a function's parameters, returning the collected
 * output parameters (which the caller folds into the JS return). `leading` is
 * prepended to the C call args (e.g. `self` for instance methods).
 */
function* emitParams(
	ctx: TypeContext,
	func: Func,
	leading: string[],
	cppParams: string[]
): Generator<string, OutParam[], void> {
	const outParams: OutParam[] = [];
	cppParams.push(...leading);
	let jsIndex = 0;
	for (const p of func.parameters) {
		if (p.isInstance) continue;
		yield* param(ctx, p, jsIndex, cppParams, outParams);
		// Output params do not consume a JS argument slot.
		if (p.direction === 'in' && !isErrorParam(p)) jsIndex++;
	}
	return outParams;
}

/**
 * After the C call, produce the JS return from the real return value plus any
 * output parameters: a lone out-param (with void return) becomes the result; a
 * void return with no out-params yields `undefined`; multiple values become an
 * object keyed by parameter name.
 */
function* emitResult(ctx: TypeContext, func: Func, resultVar: string | null, outParams: OutParam[]): Lines {
	const hasReturn = resultVar !== null;

	if (!hasReturn && outParams.length === 0) {
		yield 'return env.Undefined();';
		return;
	}
	if (!hasReturn && outParams.length === 1) {
		const o = outParams[0];
		yield* convertToJs(ctx, o.type, o.transfer, o.name, v => `return ${v};`);
		return;
	}
	if (hasReturn && outParams.length === 0) {
		yield* convertToJs(ctx, func.returnValue.type, func.returnValue.transfer, resultVar, v => `return ${v};`);
		return;
	}

	// Multiple values: bundle into an object. The real return (if any) is keyed
	// "return"; each out-param under its (stripped) name.
	yield 'Napi::Object js_result = Napi::Object::New(env);';
	if (hasReturn) {
		yield* convertToJs(
			ctx,
			func.returnValue.type,
			func.returnValue.transfer,
			resultVar,
			v => `js_result.Set("return", ${v});`
		);
	}
	for (const o of outParams) {
		yield* convertToJs(ctx, o.type, o.transfer, o.name, v => `js_result.Set("${o.key}", ${v});`);
	}
	yield 'return js_result;';
}

// --- module init ------------------------------------------------------------

/** `$init(internal)`: store the runtime ABI, then define and return every class and function. */
function* moduleInit(ctx: TypeContext, moduleName: string): Lines {
	yield 'Napi::Value module_init(const Napi::CallbackInfo& info) {';
	yield '\tNapi::Env env = info.Env();';
	yield '\tgirbind::init(info);';
	yield '\tNapi::Object exports = Napi::Object::New(env);';
	for (const { record } of boundRecords(ctx)) {
		yield `\texports.Set("${record.name}", define_${record.name}(env, girbind::lookup(env, "GBoxed")));`;
	}
	for (const cls of boundClasses(ctx)) {
		const parent = ctx.boundParent(cls);
		const parentExpression =
			parent.source === 'local'
				? `class_${shortName(parent.qualified)}`
				: `girbind::lookup(env, "${parent.typeName}")`;
		yield `\tNapi::Function class_${cls.name} = define_${cls.name}(env, ${parentExpression});`;
		yield `\texports.Set("${cls.name}", class_${cls.name});`;
	}
	for (const { func, jsName } of functionExportNames(ctx.ns)) {
		yield `\texports.Set("${jsName}", Napi::Function::New(env, Wrap_${func.cName}, "${jsName}"));`;
	}
	yield '\treturn exports;';
	yield '}';
	yield '';
	yield 'Napi::Object Init(Napi::Env env, Napi::Object exports) {';
	yield '\texports.Set("$init", Napi::Function::New(env, module_init, "$init"));';
	yield '\treturn exports;';
	yield '}';
	yield '';
	yield '} // namespace';
	yield '';
	// cmake-js (unlike node-gyp) does not define NODE_GYP_MODULE_NAME, so the
	// module is registered under an explicit name that must match the built
	// `<name>.node` and the require() path in the generated entry point.
	yield `NODE_API_MODULE(${moduleName}, Init)`;
}

export interface Options {
	/**
	 * Registered module name; must match the built `<name>.node` and the
	 * require() path in the generated JS. Defaults to the namespace name,
	 * lowercased.
	 */
	moduleName?: string;
	/**
	 * Additional `#include` directives (the library's own header), e.g.
	 * `['<flatpak/flatpak.h>']`. Bare names without `<>`/`""` are wrapped in `<>`.
	 */
	includes?: string[];
	/** Preprocessor macros to define before the includes. */
	defines?: string[];
	/** The namespace and the namespaces it includes, for resolving types from other namespaces. */
	repository?: Repository;
	/** Import specifiers of other bound namespaces, by namespace name. */
	modules?: Record<string, string>;
}

/** Always-needed includes; the target library's header is added via options. */
const BASE_INCLUDES = ['<girbind.hxx>', '<memory>', '<string>', '<vector>'];

function includeDirective(inc: string): string {
	const wrapped = inc.startsWith('<') || inc.startsWith('"') ? inc : `<${inc}>`;
	return `#include ${wrapped}`;
}

function* file(ns: Namespace, options: Options): Lines {
	const ctx = new TypeContext(ns, options.repository, options.modules);
	const moduleName = options.moduleName ?? ns.name.toLowerCase();

	const body = [
		...boundRecords(ctx).flatMap(type => [...ownerDef(ctx, recordOwner(ctx, type))]),
		...boundClasses(ctx).flatMap(cls => [...ownerDef(ctx, classOwner(ctx, cls))]),
		...ns.functions.filter(isSupported).flatMap(func => [...standalone(ctx, func)]),
		...moduleInit(ctx, moduleName),
	];

	yield `// Generated by girbind from ${ns.name}-${ns.version}`;
	yield '// DO NOT EDIT THIS FILE DIRECTLY';
	yield '';
	for (const define of options.defines ?? []) yield `#define ${define}`;
	for (const inc of [...BASE_INCLUDES, ...(options.includes ?? [])]) yield includeDirective(inc);
	yield '';
	for (const typeFunction of [...ctx.typeFunctions].sort()) yield `extern "C" GType ${typeFunction}(void);`;
	yield '';
	yield 'namespace {';
	yield '';
	yield* body;
}

export function generate(ns: Namespace, options: Options = {}): string {
	return [...file(ns, options)].join('\n') + '\n';
}
