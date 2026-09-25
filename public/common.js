export const $ = id => document.getElementById(id);

export async function api(path, options = {}) {
  const response = await fetch(`/api/${path}`, { credentials: 'same-origin', headers: options.body ? { 'Content-Type': 'application/json' } : {}, ...options });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

export function message(id, text, error = false) {
  const node = $(id);
  node.textContent = text;
  node.classList.toggle('error', error);
}

export function renderRecords(id, items, format, empty) {
  const root = $(id);
  root.replaceChildren();
  root.classList.toggle('empty', !items.length);
  if (!items.length) { root.textContent = empty; return; }
  for (const item of items) {
    const row = document.createElement('div');
    const title = document.createElement('strong');
    const meta = document.createElement('small');
    [title.textContent, meta.textContent] = format(item);
    row.className = 'record';
    row.append(title, meta);
    root.append(row);
  }
}
