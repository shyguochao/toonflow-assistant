/** Render a Markdown table; pipes and newlines in cells are escaped. */
export function table(headers: string[], rows: (string | number | undefined)[][]) {
  const cell = (value: string | number | undefined) => String(value ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map(row => `| ${row.map(cell).join(" | ")} |`),
  ].join("\n");
}

export const printJson = (value: unknown) => console.log(JSON.stringify(value, null, 2));

export const charCount = (text: string) => [...text.replace(/\s/g, "")].length;
