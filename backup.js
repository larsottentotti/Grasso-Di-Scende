'use strict';
/* Backup / restore of everything the app saves on the phone
   (decks, stats, streak, settings). Plain JSON file. */

const BACKUP_PREFIX = "gds.";

function backupCollect() {
  const data = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(BACKUP_PREFIX)) data[k] = localStorage.getItem(k);
  }
  return { app: "grasso-di-scende", savedAt: new Date().toISOString(), data };
}

function backupExport() {
  const blob = new Blob([JSON.stringify(backupCollect())], { type: "application/json" });
  const d = new Date();
  const stamp = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `grasso-backup-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  if (typeof toast === "function") toast("Backup saved to your Downloads");
}

// Returns an error string, or null when the file was restored.
function backupRestore(text) {
  let obj;
  try { obj = JSON.parse(text); } catch (e) { return "That is not a backup file."; }
  if (!obj || obj.app !== "grasso-di-scende" || !obj.data || typeof obj.data !== "object") {
    return "That is not a Grasso di scende backup.";
  }
  const keys = Object.keys(obj.data).filter(k => k.startsWith(BACKUP_PREFIX));
  if (!keys.length) return "The backup is empty.";

  const old = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(BACKUP_PREFIX)) old.push(k);
  }
  old.forEach(k => localStorage.removeItem(k));
  keys.forEach(k => localStorage.setItem(k, String(obj.data[k])));
  return null;
}

function initBackup() {
  const exp = document.getElementById("btn-backup-export");
  const file = document.getElementById("file-backup");
  if (!exp || !file) return;

  exp.addEventListener("click", backupExport);
  file.addEventListener("change", () => {
    const f = file.files && file.files[0];
    if (!f) return;
    if (!confirm("Restore this backup? It replaces everything currently saved in the app.")) {
      file.value = "";
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const err = backupRestore(String(reader.result));
      if (err) { if (typeof toast === "function") toast(err); file.value = ""; return; }
      location.reload();
    };
    reader.readAsText(f);
  });
}

initBackup();
