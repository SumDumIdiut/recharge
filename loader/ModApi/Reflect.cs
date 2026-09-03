using System;
using System.Reflection;

namespace Recharge.ModApi
{
    /// <summary>
    /// Generic reflection helpers for reaching the game's private fields,
    /// properties, and methods - every real mod needs this constantly (the
    /// real game classes expose almost nothing public), and every one so far
    /// hand-rolled its own <c>BindingFlags.NonPublic | BindingFlags.Instance</c>
    /// boilerplate. Static, no state, safe to call from anywhere - not tied
    /// to <see cref="IRechargeHost"/> since it doesn't need a live host.
    /// </summary>
    public static class Reflect
    {
        private const BindingFlags Instance = BindingFlags.NonPublic | BindingFlags.Public | BindingFlags.Instance;
        private const BindingFlags Statics = BindingFlags.NonPublic | BindingFlags.Public | BindingFlags.Static;

        /// <summary>Reads an instance field (public or private) by name, walking up the base-type chain if the declaring type isn't <paramref name="target"/>'s own.</summary>
        public static T GetField<T>(object target, string fieldName)
        {
            var field = FindField(target.GetType(), fieldName);
            if (field == null) throw new MissingFieldException(target.GetType().FullName, fieldName);
            return (T)field.GetValue(target);
        }

        /// <summary>Writes an instance field (public or private) by name, walking up the base-type chain if needed.</summary>
        public static void SetField(object target, string fieldName, object value)
        {
            var field = FindField(target.GetType(), fieldName);
            if (field == null) throw new MissingFieldException(target.GetType().FullName, fieldName);
            field.SetValue(target, value);
        }

        /// <summary>Like <see cref="GetField{T}"/> but returns <paramref name="fallback"/> instead of throwing if the field doesn't exist.</summary>
        public static T TryGetField<T>(object target, string fieldName, T fallback = default)
        {
            var field = FindField(target.GetType(), fieldName);
            return field != null ? (T)field.GetValue(target) : fallback;
        }

        /// <summary>Reads a static field (public or private) on <typeparamref name="T"/> by name.</summary>
        public static TValue GetStaticField<T, TValue>(string fieldName)
        {
            var field = typeof(T).GetField(fieldName, Statics);
            if (field == null) throw new MissingFieldException(typeof(T).FullName, fieldName);
            return (TValue)field.GetValue(null);
        }

        /// <summary>Reads an instance property (public or private getter) by name.</summary>
        public static T GetProperty<T>(object target, string propertyName)
        {
            var prop = target.GetType().GetProperty(propertyName, Instance);
            if (prop == null) throw new MissingMemberException(target.GetType().FullName, propertyName);
            return (T)prop.GetValue(target);
        }

        /// <summary>
        /// Invokes an instance method (public or private) by name. Overload
        /// resolution is by argument COUNT only (the common case - most real
        /// game methods you'll reach this way aren't overloaded); if that's
        /// ambiguous for your target, fetch the exact <see cref="MethodInfo"/>
        /// yourself instead.
        /// </summary>
        public static object InvokeMethod(object target, string methodName, params object[] args)
        {
            var method = target.GetType().GetMethod(methodName, Instance, null, ArgTypes(args), null)
                ?? FindMethodByArgCount(target.GetType(), methodName, args.Length);
            if (method == null) throw new MissingMethodException(target.GetType().FullName, methodName);
            return method.Invoke(target, args);
        }

        /// <summary>
        /// Gets a private nested type declared on <typeparamref name="T"/> -
        /// needed to construct/reflect into a private struct like a real
        /// component's own "PositionData"-style config record.
        /// </summary>
        public static Type NestedType<T>(string nestedTypeName)
        {
            var type = typeof(T).GetNestedType(nestedTypeName, BindingFlags.NonPublic | BindingFlags.Public);
            if (type == null) throw new MissingMemberException(typeof(T).FullName, nestedTypeName);
            return type;
        }

        private static FieldInfo FindField(Type type, string fieldName)
        {
            for (var t = type; t != null; t = t.BaseType)
            {
                var field = t.GetField(fieldName, Instance | BindingFlags.DeclaredOnly);
                if (field != null) return field;
            }
            return null;
        }

        private static Type[] ArgTypes(object[] args)
        {
            var types = new Type[args.Length];
            for (int i = 0; i < args.Length; i++) types[i] = args[i]?.GetType() ?? typeof(object);
            return types;
        }

        private static MethodInfo FindMethodByArgCount(Type type, string methodName, int argCount)
        {
            foreach (var m in type.GetMethods(Instance))
            {
                if (m.Name == methodName && m.GetParameters().Length == argCount) return m;
            }
            return null;
        }
    }
}
