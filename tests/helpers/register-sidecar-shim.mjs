import * as nodeModule from 'node:module';

const shimUrl = new URL('./sidecar-sdk-shim.mjs', import.meta.url).href;

if (typeof nodeModule.registerHooks === 'function') {
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === 'sidecar_sdk') {
        return { shortCircuit: true, url: shimUrl };
      }
      return nextResolve(specifier, context);
    },
  });
} else {
  const loaderSrc = `export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'sidecar_sdk') {
    return { shortCircuit: true, url: ${JSON.stringify(shimUrl)} };
  }
  return nextResolve(specifier, context);
}`;
  nodeModule.register(`data:text/javascript;base64,${Buffer.from(loaderSrc, 'utf-8').toString('base64')}`);
}
