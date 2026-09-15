import { stripServedComments } from "./strip-served-comments";

// 2df0e973 click-to-edit (W1, Day 227). Own file, matching this repo's convention
// (validator-view.ts, readaloud.ts are each "own file" for the same reason -- a merge against
// page_sections/site work touching the same area stays trivial).
//
// Cloud's benchmark ruling (cc9b35f3, durable.com): a hover toolbar per section -- Edit, move
// up, move down, delete. Skip "Design" for now. No drag reorder (buttons only, per the original
// scope), no rich formatting (contenteditable="plaintext-only", innerText read on save -- never
// innerHTML, so pasted markup can never survive a save).
//
// Gate (66eaa00c, corrected from an earlier isDarren() draft in this handoff): the WORKSPACE
// OWNER editing their own pages, not Darren specifically. The server decides once, at render
// time, whether the signed-in viewer's id matches workspace.owner_user_id -- if not (including
// an anonymous /site/<id> visitor), it renders the exact same read-only markup this repo
// already had, never ships the editor markup or script to a non-owner at all.
//
// SAVE MODEL: page_sections is REPLACE-ALL (savePageSections deletes then re-inserts the whole
// ordered list for a (workspace, page) pair, see index.ts) -- so there is no per-row PATCH here.
// Every action (finish editing a block, add, remove, move) re-POSTs the FULL current section
// list to ONE endpoint, /api/edit/sections. This matches the existing whole-form autosave
// pattern already used elsewhere in this repo rather than inventing a second save shape.

export type EditSection = { heading: string; body: string };

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export const BLOCKEDIT_CSS = stripServedComments(`
.eb{position:relative}
.eb[data-editing="1"]{outline:2px dashed var(--rule);outline-offset:6px;border-radius:10px}
.eb-toolbar{display:none;gap:4px;margin-bottom:8px}
.eb:hover .eb-toolbar,.eb[data-editing="1"] .eb-toolbar{display:flex}
.eb-btn{font:700 12px/1 inherit;border:1px solid var(--rule);background:#fff;color:var(--ink);border-radius:999px;padding:6px 10px;cursor:pointer}
.eb-btn:disabled{opacity:.35;cursor:default}
.eb-del{color:#B3261E;border-color:#F3C6C2}
.eb-heading[contenteditable],.eb-body[contenteditable]{outline:2px solid var(--accent2);outline-offset:2px;border-radius:6px}
.eb-add{display:block;width:100%;margin-top:6px;font:700 14px/1 inherit;border:1px dashed var(--rule);background:transparent;color:var(--muted);border-radius:14px;padding:14px;cursor:pointer}
.eb-add:hover{border-color:var(--accent);color:var(--accent)}
.eb-empty{color:var(--muted);font-size:13px;margin:0 0 10px}
`);

export function editableSectionHtml(s: EditSection, index: number, count: number): string {
  return (
    `<div class="eb" data-pos="${index}">` +
    `<div class="eb-toolbar">` +
    `<button type="button" class="eb-btn" data-act="edit">Edit</button>` +
    `<button type="button" class="eb-btn" data-act="up"${index === 0 ? " disabled" : ""}>&uarr;</button>` +
    `<button type="button" class="eb-btn" data-act="down"${index === count - 1 ? " disabled" : ""}>&darr;</button>` +
    `<button type="button" class="eb-btn eb-del" data-act="del">&times;</button>` +
    `</div>` +
    `<h2 class="eb-heading" data-field="heading">${escapeHtml(s.heading)}</h2>` +
    `<p class="eb-body" data-field="body">${escapeHtml(s.body)}</p>` +
    `</div>`
  );
}

export function editRootOpenHtml(page: string): string {
  return `<div id="eb-root" data-eb-page="${escapeHtml(page)}">`;
}

export function editAddButtonHtml(): string {
  return `<button type="button" class="eb-add" id="ebAdd">+ Add section</button>`;
}

// ES5, matching readaloud.ts and every other inline script in this repo (no build step yet).
export const BLOCKEDIT_SCRIPT = stripServedComments(`
<script>
(function(){
  var root = document.getElementById('eb-root');
  if (!root) return;
  var page = root.getAttribute('data-eb-page');
  var addBtn = document.getElementById('ebAdd');

  function fieldsOf(block){
    return { h: block.querySelector('[data-field="heading"]'), b: block.querySelector('[data-field="body"]') };
  }

  function save(){
    var blocks = Array.prototype.slice.call(root.querySelectorAll('.eb'));
    var sections = blocks.map(function(el){
      var f = fieldsOf(el);
      return { heading: (f.h.innerText || '').trim(), body: (f.b.innerText || '').trim() };
    });
    fetch('/api/edit/sections', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ page: page, sections: sections }),
    });
  }

  function renumber(){
    var blocks = Array.prototype.slice.call(root.querySelectorAll('.eb'));
    blocks.forEach(function(el, i){
      el.setAttribute('data-pos', i);
      var up = el.querySelector('[data-act="up"]'); if (up) up.disabled = (i === 0);
      var down = el.querySelector('[data-act="down"]'); if (down) down.disabled = (i === blocks.length - 1);
    });
  }

  function stopEditing(block, btn){
    var f = fieldsOf(block);
    f.h.removeAttribute('contentEditable'); f.b.removeAttribute('contentEditable');
    block.removeAttribute('data-editing');
    btn.textContent = 'Edit';
  }

  root.addEventListener('click', function(e){
    var btn = e.target.closest ? e.target.closest('.eb-btn') : null;
    if (!btn) return;
    var block = btn.closest('.eb');
    var act = btn.getAttribute('data-act');

    if (act === 'edit'){
      var editing = block.getAttribute('data-editing') === '1';
      var f = fieldsOf(block);
      if (!editing){
        f.h.contentEditable = 'plaintext-only'; f.b.contentEditable = 'plaintext-only';
        block.setAttribute('data-editing', '1'); btn.textContent = 'Done';
        f.h.focus();
      } else {
        stopEditing(block, btn);
        save();
      }
      return;
    }
    if (act === 'up' || act === 'down'){
      var sib = act === 'up' ? block.previousElementSibling : block.nextElementSibling;
      if (!sib || !sib.classList || !sib.classList.contains('eb')) return;
      if (act === 'up') root.insertBefore(block, sib); else root.insertBefore(sib, block);
      renumber();
      save();
      return;
    }
    if (act === 'del'){
      if (!window.confirm('Remove this section?')) return;
      block.parentNode.removeChild(block);
      renumber();
      save();
      return;
    }
  });

  if (addBtn) addBtn.addEventListener('click', function(){
    var count = root.querySelectorAll('.eb').length;
    var div = document.createElement('div');
    div.className = 'eb'; div.setAttribute('data-pos', count); div.setAttribute('data-editing', '1');
    var toolbar = document.createElement('div');
    toolbar.className = 'eb-toolbar';
    toolbar.innerHTML =
      '<button type="button" class="eb-btn" data-act="edit">Done</button>' +
      '<button type="button" class="eb-btn" data-act="up">&uarr;</button>' +
      '<button type="button" class="eb-btn" data-act="down" disabled>&darr;</button>' +
      '<button type="button" class="eb-btn eb-del" data-act="del">&times;</button>';
    var h = document.createElement('h2');
    h.className = 'eb-heading'; h.setAttribute('data-field', 'heading'); h.contentEditable = 'plaintext-only';
    var b = document.createElement('p');
    b.className = 'eb-body'; b.setAttribute('data-field', 'body'); b.contentEditable = 'plaintext-only';
    div.appendChild(toolbar); div.appendChild(h); div.appendChild(b);
    root.insertBefore(div, addBtn);
    renumber();
    h.focus();
  });
})();
</script>`);
