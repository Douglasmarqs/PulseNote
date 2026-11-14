const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const html = read("src/index.html");
const app = read("src/app.js");

test("tela de Notas mantém todos os campos usados pelo app", () => {
  for (const id of ["noteForm", "noteId", "noteTitle", "noteDescription", "notePriority", "noteChecklistToggle", "noteChecklistField", "noteChecklist",
    "noteCategory", "noteFolder", "noteTags", "noteGoal", "noteAttachments", "noteObservations", "noteColor", "noteTextColor", "resetNoteForm",
    "noteEditingBanner", "cancelEditNote", "noteSaveBtnLabel", "noteFilter", "noteFolders", "notesList",
    "noteDetailModal", "closeNoteDetail", "ndTitle", "ndMeta", "ndBody", "ndFavBtn", "ndDeleteBtn", "ndMoreFieldsBtn", "ndConvertTaskBtn", "ndSaveBtn",
    "noteDetailToolbar", "ndChecklistSection", "ndChecklistItems", "ndChecklistProgress", "ndChecklistProgressBar", "ndChecklistSummary"]) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  for (const cmd of ["bold", "italic", "underline", "ul", "ol", "link", "more", "highlight", "clear", "checklist"]) {
    assert.match(html, new RegExp(`data-nd-cmd="${cmd}"`), cmd);
  }
});

test("campo de link aceita endereço sem https (o app completa)", () => {
  assert.match(html, /id="ndLinkForm" hidden novalidate/);
  assert.match(html, /id="ndLinkInput" type="text" inputmode="url"/);
  assert.match(app, /url = `https:\/\/\$\{url\}`/);
});

test("sanitizador da nota mantém só links http(s)/mailto e abre em nova aba", () => {
  assert.match(app, /"U", "UL", "OL", "LI", "A"/);
  assert.match(app, /node\.setAttribute\("rel", "noopener noreferrer"\)/);
});

test("o body não usa data-view (bindNavigation liga clique em todo [data-view])", () => {
  assert.doesNotMatch(app, /document\.body\.dataset\.view\s*=/);
  assert.match(app, /document\.body\.dataset\.activeView = view/);
});
