// ../pub-game-store/native/files/scan.js
// reconstructed from the esbuild bundle in eboot.bin


  var KINDS = [
    { key: "packages", icon: "package", folders: ["downloads/packages"] },
    // downloads/images holds images still being downloaded or checked, before they move into homebrew.
    { key: "images", icon: "disc", folders: ["homebrew", "downloads/images"] },
    { key: "archives", icon: "archive", folders: ["downloads/archives", "downloads/sets"] },
    { key: "extracted", icon: "folder", folders: ["downloads/extracted"] },
    { key: "other", icon: "file", folders: ["downloads/files"] }
  ];
  // `.partial`: a copy FileSystem.copyAsync is still writing (a game moving to this drive).
  var SIDECAR = /\.(?:complete|part|resume|tmp|partial)$|^\.ps5-react-/;
  var TITLE_ID = /\b(CUSA|PPSA)\d{5}\b/;
  var DEPTH = 4;
  var ENTRIES = 4e3;
  var isPackage = (name) => /\.f?pkg$/i.test(name);
  function folderSize(fs, path, depth, budget) {
    let total = 0;
    let entries2;
    try {
      entries2 = fs.readDir(path);
    } catch {
      return 0;
    }
    for (const entry2 of entries2) {
      if (--budget.left < 0) return total;
      if (entry2.isDirectory) {
        if (depth > 0) total += folderSize(fs, `${path}/${entry2.name}`, depth - 1, budget);
      } else total += entry2.size || 0;
    }
    return total;
  }
  // glibren.17: a PS5 game folder (eboot.bin + sce_sys/param.json with a PPSA code), the folder itself or the one folder
  // inside it (an extraction's): { folder, titleId } for "Convert to .exfat", or null.
  function ps5GameFolder(fs, path) {
    const look = (folder) => {
      try {
        if (!fs.exists(`${folder}/eboot.bin`) || !fs.exists(`${folder}/sce_sys/param.json`)) return null;
        const titleId = String(JSON.parse(fs.readFile(`${folder}/sce_sys/param.json`))?.titleId || "").toUpperCase();
        return /^PPSA\d{5}$/.test(titleId) ? { folder, titleId } : null;
      } catch {
        return null;
      }
    };
    const found = look(path);
    if (found) return found;
    let children = [];
    try {
      children = fs.readDir(path).filter((entry2) => !entry2.name.startsWith(".ps5-react"));
    } catch {
      return null;
    }
    return children.length === 1 && children[0].isDirectory ? look(`${path}/${children[0].name}`) : null;
  }
  // `kinds`: the folders to read (all of them by default; the library reads homebrew alone).
  function scanDrive(fs, root2, kinds = KINDS) {
    const files = [];
    for (const kind of kinds) {
      for (const folder of kind.folders) {
        let entries2;
        try {
          entries2 = fs.readDir(`${root2}/${folder}`);
        } catch {
          continue;
        }
        // homebrew/backports holds one folder per title (backports ShadowMount lays over that game): each
        // is listed on its own, so deleting one never takes the others.
        if (folder === "homebrew") {
          const backports = entries2.find((entry2) => entry2.isDirectory && entry2.name === "backports");
          if (backports) {
            entries2 = entries2.filter((entry2) => entry2 !== backports);
            let titles = [];
            try {
              titles = fs.readDir(`${root2}/homebrew/backports`);
            } catch {
            }
            for (const entry2 of titles) {
              if (SIDECAR.test(entry2.name)) continue;
              const path = `${root2}/homebrew/backports/${entry2.name}`;
              const titleId = TITLE_ID.exec(entry2.name)?.[0] ?? null;
              files.push({
                kind: "other",
                backport: true,
                path,
                name: entry2.name,
                isDirectory: entry2.isDirectory,
                modified: entry2.modified,
                size: entry2.isDirectory ? folderSize(fs, path, DEPTH, { left: ENTRIES }) : entry2.size || 0,
                titleId,
                platform: titleId ? titleId.startsWith("CUSA") ? "ps4" : "ps5" : null
              });
            }
          }
        }
        for (const entry2 of entries2) {
          if (SIDECAR.test(entry2.name)) continue;
          const path = `${root2}/${folder}/${entry2.name}`;
          const game = entry2.isDirectory && ["homebrew", "downloads/extracted"].includes(folder) ? ps5GameFolder(fs, path) : null;
          const titleId = TITLE_ID.exec(entry2.name)?.[0] ?? game?.titleId ?? null;
          files.push({
            ...game ? { ps5Folder: game.folder } : {},
            kind: kind.key,
            path,
            name: entry2.name,
            isDirectory: entry2.isDirectory,
            modified: entry2.modified,
            size: entry2.isDirectory ? folderSize(fs, path, DEPTH, { left: ENTRIES }) : entry2.size || 0,
            titleId,
            platform: titleId ? titleId.startsWith("CUSA") ? "ps4" : "ps5" : null
          });
        }
      }
    }
    return files.sort((a, b) => b.size - a.size || a.name.localeCompare(b.name));
  }
  function totals(files) {
    const out = Object.fromEntries([["all", { count: 0, size: 0 }], ...KINDS.map((kind) => [kind.key, { count: 0, size: 0 }])]);
    for (const file of files) for (const key of ["all", file.kind]) {
      out[key].count++;
      out[key].size += file.size;
    }
    return out;
  }
  var deletionTargets = (file) => file.isDirectory ? [file.path] : [file.path, ...[".complete", ".resume", ".part"].map((suffix) => file.path + suffix)];

export { KINDS, deletionTargets, isPackage, ps5GameFolder, scanDrive, totals };
