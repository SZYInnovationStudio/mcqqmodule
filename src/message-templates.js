export function formatMessageTemplate(template, values) {
  return String(template).replace(/\$\{([A-Za-z]+)\}/g, (whole, name) =>
    Object.hasOwn(values, name) ? String(values[name]) : whole);
}

