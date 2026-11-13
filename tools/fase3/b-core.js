// Fase 3 (prototipo B): o @ps5-react/core do nucleo QuickJS sem tela. O FileSystem e o relogio sao funcoes em C do
// host (tools/fase3/b_host.c, globalThis.__host); nada desenha. Baseado em tools/memory/qjs-core.js (o mesmo contrato),
// sem qjs:std/qjs:os. A rede (Http) fica de fora: no payload quem baixa os feeds e o C (libcurl, como bg_orbit.c) e o
// nucleo le os arquivos ja gravados. Os timers sao guardados e nunca rodam neste prototipo (a montagem nao espera nenhum).
const H = globalThis.__host;
const pending = [];
globalThis.setTimeout ??= (fn) => { pending.push(fn); return pending.length; };
globalThis.clearTimeout ??= () => {};
globalThis.setInterval ??= () => 0;
globalThis.clearInterval ??= () => {};
globalThis.console ??= {};
globalThis.console.log ??= (...a) => H.log(a.join(' '));
globalThis.console.warn ??= () => {};

export const FileSystem = {
  appDir: '/app0',
  dataDir: '/data',
  tempDir: '/temp0',
  exists: (path) => H.stat(path) !== null,
  readFile(path, offset, length) {
    const text = offset !== undefined ? H.readFile(path, offset, length) : H.readFile(path);
    if (text === null) throw new Error(`readFile ${path}: No such file or directory`);
    return text;
  },
  writeFile(path, text, append = false) { if (!H.writeFile(path, String(text), append)) throw new Error(`writeFile ${path}: cannot open`); },
  appendFile(path, text) { this.writeFile(path, text, true); },
  mkdir(path) { H.mkdir(path); },
  rename(from, to) { if (!H.rename(from, to)) throw new Error(`rename ${from}: failed`); },
  remove(path) { H.remove(path); },
  removeTree(path) { H.remove(path); },
  stat(path) {
    const st = H.stat(path);
    return st ? { name: path.split('/').pop(), isDirectory: st.dir, isFile: !st.dir, size: st.size, modified: st.modified } : null;
  },
  readDir: () => [],
  mounts: () => [],
  diskUsage: () => ({ total: 1e12, free: 5e11 }),
};
export const Http = { request: async () => { throw new Error('no network in the catalog core'); } };
export const Platform = { OS: 'ps5', select: (spec) => spec.ps5 ?? spec.default };
export const DeviceInfo = { utcOffset: () => 0, get: () => ({ language: 'en-US' }), memory: () => { const m = H.mem(); return { heapUsed: m[0], heapLimit: m[2] }; } };
export const Notifications = { show() {}, notify() {} };
export const Image = { warm() {}, prefetch: () => Promise.resolve(), setRouter() {} };
export const Downloads = { setConcurrency: () => 1, enqueue() { throw new Error('no downloads here'); } };
export const DownloadFormats = { images: ['exfat', 'ffpfs', 'ffpfsc', 'ffpkg'] };
export const Payloads = { send: () => ({ ok: false, error: 'core' }) };
export const BackHandler = { exitApp() {}, addEventListener: () => ({ remove() {} }) };
export const LocalServer = { token() { throw new Error('no server here'); } };
export const Keyboard = { available: false, isOpen: false, open() {}, close() {} };
export const Fonts = { setLanguage() {} };
export const Archives = {};
export const Packages = {};
export const SelfUpdate = {};
export const Power = { keepAwake() {} };
export const Users = { foreground: () => null, loggedIn: () => [] };
export const BrowserCapture = {};
export const Linking = { openURL() {} };
export const Sound = { play() {} };
export const Controller = { subscribe: () => () => {} };
export const LayoutAnimation = {};
export const transitions = {};
export const setLightMotion = () => {};
export const useController = () => {};
export const useControllerEvents = () => {};
export const useFocus = () => ({ focus: () => false });
export const useFocusActions = () => ({});
export const useIsFocused = () => false;
export const useNavigationEvents = () => {};
export const motion = { View: 'motion.View' };
export const View = 'View', Text = 'Text', ScrollView = 'ScrollView', FocusScope = 'FocusScope', AnimatePresence = 'AnimatePresence';
export const Svg = 'Svg', Path = 'Path', Video = 'Video', VirtualList = 'VirtualList';
export default {};
