// glibren (medidor de memoria): o @ps5-react/core dos cenarios de tools/memory/measure.mjs, no qjs (QuickJS-ng 0.15, o
// mesmo motor do ps5-react). Os arquivos do app (/app0/...) sao a pasta app/ do repositorio; o resto fica numa pasta de
// trabalho (globalThis.__MEM_FS), um arquivo por caminho. O Http responde pelo globalThis.__MEM_HTTP do cenario.
// Nada aqui desenha: os componentes e ganchos sao nomes vazios.
import * as std from 'qjs:std';
import * as os from 'qjs:os';

globalThis.setTimeout ??= os.setTimeout;
globalThis.clearTimeout ??= os.clearTimeout;
globalThis.setInterval ??= (fn, ms) => { const tick = () => { fn(); id.t = os.setTimeout(tick, ms); }; const id = { t: os.setTimeout(tick, ms) }; return id; };
globalThis.clearInterval ??= (id) => id && os.clearTimeout(id.t);
globalThis.console ??= { log: (...a) => print(...a) };
globalThis.console.warn ??= () => {};

const real = (path) => {
  if (path.startsWith('/app0/')) return globalThis.__MEM_APP + path.slice(6);
  return globalThis.__MEM_FS + '/' + encodeURIComponent(path);
};
export const FileSystem = {
  appDir: '/app0',
  dataDir: '/data',
  tempDir: '/temp0',
  exists: (path) => os.stat(real(path))[1] === 0,
  readFile(path, offset, length) {
    // glibren.47: um trecho (um item de um pacote de dados), como o readFile(path, offset, length) do console.
    if (offset !== undefined) {
      const file = std.open(real(path), 'rb');
      if (!file) throw new Error(`readFile ${path}: No such file or directory`);
      try {
        file.seek(offset, std.SEEK_SET);
        return file.readAsString(length);
      } finally {
        file.close();
      }
    }
    const text = std.loadFile(real(path));
    if (text == null) throw new Error(`readFile ${path}: No such file or directory`);
    return text;
  },
  writeFile(path, text, append = false) {
    const file = std.open(real(path), append ? 'a' : 'w');
    if (!file) throw new Error(`writeFile ${path}: cannot open`);
    file.puts(String(text));
    file.close();
  },
  appendFile(path, text) { this.writeFile(path, text, true); },
  mkdir() {},
  rename(from, to) { os.rename(real(from), real(to)); },
  remove(path) { os.remove(real(path)); },
  removeTree(path) { os.remove(real(path)); },
  stat(path) {
    const [st, err] = os.stat(real(path));
    return err ? null : { name: path.split('/').pop(), isDirectory: false, isFile: true, size: st.size, modified: st.mtime };
  },
  readDir: () => [],
  mounts: () => [],
  diskUsage: () => ({ total: 1e12, free: 5e11 }),
};
export const Http = { request: (url, options = {}) => globalThis.__MEM_HTTP(url, options) };
export const Platform = { OS: 'ps5', select: (spec) => spec.ps5 ?? spec.default };
// glibren.44: com o qjs de tools/memory/peak.mjs (std.mem() = [uso agora, pico] do heap do JS) o medidor do app mede como
// no console (limite 64 MiB, o kJsMemoryLimit do ps5-react); com o qjs comum, nada (como antes).
export const DeviceInfo = { utcOffset: () => 0, get: () => ({ language: 'en-US' }),
  memory: () => {
    if (typeof std.mem !== 'function') return null;
    // MEM_GC=1: coleta antes de medir (o que fica vivo, sem o lixo de ciclos que o console ainda nao coletou).
    if (std.getenv('MEM_GC')) std.gc();
    return { heapUsed: std.mem()[0], heapLimit: 64 * 1024 * 1024 };
  } };
export const Notifications = { show() {}, notify() {} };
export const Image = { warm() {}, prefetch: () => Promise.resolve(), setRouter() {} };
export const Downloads = { setConcurrency: () => 1, enqueue() { throw new Error('no downloads here'); } };
export const DownloadFormats = { images: ['exfat', 'ffpfs', 'ffpfsc', 'ffpkg'] };
export const Payloads = { send: () => ({ ok: false, error: 'qjs' }) };
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
