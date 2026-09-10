import * as React from 'react'
import { renderRevision, valueVersion } from 'preview-runtime'
export * from 'react'

// Restoring a mutable ref deliberately preserves its identity. React's usual
// identity-only cache keys cannot see that its contents changed. Add one scalar
// revision during restore commits; ordinary application renders keep their keys.
function dependencies(values) {
  return values == null ? values : [renderRevision(), ...values, ...values.map(valueVersion)]
}
export function useMemo(create, values) { return React.useMemo(create, dependencies(values)) }
export function useCallback(callback, values) { return React.useCallback(callback, dependencies(values)) }

function shallowEqual(previous, next) {
  if (Object.is(previous, next)) return true
  const keys = Object.keys(previous)
  if (keys.length !== Object.keys(next).length) return false
  for (const key of keys) if (!Object.hasOwn(next, key) || !Object.is(previous[key], next[key])) return false
  return true
}
export function memo(component, compare = shallowEqual) {
  // Only committed props certify a cached render. Recording in the comparator
  // would incorrectly certify an interrupted or abandoned concurrent render.
  const committed = new WeakMap()
  const Render = React.forwardRef(function PreviewMemo(props, ref) {
    const revision = renderRevision()
    const versions = Object.keys(props).map(key => ({ key, version: valueVersion(props[key]) }))
    React.useLayoutEffect(() => { committed.set(props, { revision, versions }) })
    return React.createElement(component, ref === null ? props : { ...props, ref })
  })
  const wrapped = React.memo(Render, (previous, next) => {
    const before = committed.get(previous)
    return before !== undefined && before.revision === renderRevision()
      && before.versions.every(item => item.version === valueVersion(previous[item.key]))
      && (compare === null ? shallowEqual(previous, next) : compare(previous, next))
  })
  if (component.defaultProps !== undefined) wrapped.defaultProps = component.defaultProps
  wrapped.displayName = component.displayName ?? component.name ?? 'PreviewMemo'
  return wrapped
}
export default { ...React, useMemo, useCallback, memo }
