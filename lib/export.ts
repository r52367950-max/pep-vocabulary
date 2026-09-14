export function delimitedCell(value: string, format: "csv" | "tsv") {
  // Quoting alone does not prevent spreadsheet formula execution.
  const safe = /^[\s\u0000-\u001f]*[=+@-]/u.test(value) ? `'${value}` : value;
  return format === "csv" ? `"${safe.replaceAll('"', '""')}"` : safe.replace(/[\t\r\n]/g, " ");
}
