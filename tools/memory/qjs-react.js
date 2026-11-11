// glibren (medidor de memoria): react e react/jsx-runtime dos cenarios de tools/memory/measure.mjs (nada desenha).
export const useState = (value) => [typeof value === 'function' ? value() : value, () => {}];
export const useEffect = () => {};
export const useLayoutEffect = () => {};
export const useMemo = (make) => make();
export const useCallback = (fn) => fn;
export const useRef = (value) => ({ current: value });
export const memo = (component) => component;
export const createContext = (value) => ({ value, Provider: 'Provider' });
export const useContext = (context) => context?.value;
export const createElement = (type, props, ...children) => ({ type, props: { ...props, children } });
export const jsx = (type, props, key) => ({ type, props, key });
export const jsxs = jsx;
export const Fragment = 'Fragment';
export default {};
