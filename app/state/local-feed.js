// glibren.14: catalog feeds that are a file on the console (state/feeds.js): a .json the player keeps on the internal
// drive or on a USB / extended drive, linked from Settings. The link is the file's path; the file is read again at
// every launch (and on Refresh feeds) and never written, moved or deleted by the app.
//
//   checkLocalPath(value)   the path, checked (absolute, no "..", only .json, only under /data, /mnt/usbN, /mnt/extN);
//                           "file:///data/x.json" is taken too. Throws with the reason when it cannot be used.
//   isLocalFeed(url)        whether a feed in feeds.json is such a file (its entry starts with "/")
//   feedFolder(fs, dir)     a folder's subfolders and .json files, for the file picker (ui/FeedFilePicker.jsx)
//   parentFolder(dir)       the folder above, or null at a drive's root

  var LOCAL_ROOT = /^\/(?:data|mnt\/(?:usb|ext)\d+)(?=\/|$)/;
  var MAX_PATH = 1024;
  // Shown in the picker at most (a folder of thousands of files is listed only in part).
  var MAX_ENTRIES = 400;
  var isLocalFeed = (url) => typeof url === "string" && url.startsWith("/");
  var localRootOf = (path) => LOCAL_ROOT.exec(path)?.[0] ?? null;
  function checkLocalPath(value) {
    let path = (value || "").trim();
    if (/^file:\/\//i.test(path)) {
      path = path.slice(7);
      try {
        path = decodeURIComponent(path);
      } catch {
        throw new Error("That file address is not valid.");
      }
    }
    if (!path.startsWith("/")) throw new Error("Enter the file's full path, such as /data/feeds/catalog.json.");
    if (path.length > MAX_PATH || /[\x00-\x1f\x7f\\]/.test(path)) throw new Error("That path is not valid.");
    const parts = path.split("/").slice(1);
    if (parts.some((part) => part === "" || part === "." || part === "..")) throw new Error("That path is not valid.");
    if (!/\.json$/i.test(path)) throw new Error("Choose a .json file.");
    const root = localRootOf(path);
    if (!root || root === path) throw new Error("Only files on the internal drive (/data) or a USB or extended drive can be linked.");
    return path;
  }
  function parentFolder(dir) {
    const root = localRootOf(dir);
    if (!root || dir === root) return null;
    return dir.slice(0, dir.lastIndexOf("/")) || null;
  }
  // { folders: [{ name, path }], files: [{ name, path, size }], more } sorted by name; hidden entries and the
  // runtime's own scratch folders (.ps5-react-*) are left out. Throws when the folder cannot be listed.
  function feedFolder(fs, dir) {
    const folders = [], files = [];
    for (const entry of fs.readDir(dir) ?? []) {
      const name = entry?.name;
      if (typeof name !== "string" || !name || name.startsWith(".")) continue;
      const path = `${dir}/${name}`;
      if (entry.isDirectory) folders.push({ name, path });
      else if (entry.isFile !== false && /\.json$/i.test(name)) files.push({ name, path, size: typeof entry.size === "number" ? entry.size : null });
    }
    const byName = (a, b) => a.name.localeCompare(b.name, void 0, { sensitivity: "base", numeric: true });
    folders.sort(byName);
    files.sort(byName);
    const all = folders.length + files.length;
    const keptFolders = folders.slice(0, MAX_ENTRIES);
    const keptFiles = files.slice(0, Math.max(0, MAX_ENTRIES - keptFolders.length));
    return { folders: keptFolders, files: keptFiles, more: all - keptFolders.length - keptFiles.length };
  }

export { LOCAL_ROOT, checkLocalPath, feedFolder, isLocalFeed, localRootOf, parentFolder };
