/** Minimal, safe markdown → HTML for chat bubbles. */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function inline(s: string): string {
  return s
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
}

export function renderMarkdown(src: string): string {
  const escaped = escapeHtml(src);
  const blocks = escaped.split(/```/);
  let html = "";

  blocks.forEach((block, i) => {
    if (i % 2 === 1) {
      // code fence: first line may be a language label
      const nl = block.indexOf("\n");
      const code = nl === -1 ? block : block.slice(nl + 1);
      html += `<pre><code>${code.replace(/\n$/, "")}</code></pre>`;
      return;
    }

    const lines = block.split("\n");
    let listType: "ul" | "ol" | null = null;
    let para: string[] = [];
    let li = 0;

    const flushPara = () => {
      if (para.length) {
        html += `<p>${inline(para.join(" "))}</p>`;
        para = [];
      }
    };
    const flushList = () => {
      if (listType) {
        html += `</${listType}>`;
        listType = null;
      }
    };

    for (; li < lines.length; li++) {
      const line = lines[li];
      const t = line.trimEnd();
      if (!t.trim()) {
        flushPara();
        flushList();
        continue;
      }
      if (/^-{3,}$/.test(t.trim())) {
        flushPara();
        flushList();
        html += "<hr/>";
        continue;
      }
      // pipe table: current row + separator row (---)
      if (
        t.trim().startsWith("|") &&
        t.trim().endsWith("|") &&
        li + 1 < lines.length &&
        /^\|?[\s:|-]+\|[\s:|-]*\|?$/.test(lines[li + 1].trim()) &&
        /-{2,}/.test(lines[li + 1])
      ) {
        flushPara();
        flushList();
        const rows: string[][] = [];
        while (li < lines.length) {
          const r = lines[li].trim();
          if (!r.startsWith("|") || !r.endsWith("|")) break;
          rows.push(r.slice(1, -1).split("|").map((c) => c.trim()));
          li++;
        }
        li--; // outer loop re-increments
        const head = rows[0] ?? [];
        const body = rows.slice(2);
        html += "<table><thead><tr>";
        for (const c of head) html += `<th>${inline(c)}</th>`;
        html += "</tr></thead><tbody>";
        for (const r of body) {
          html += "<tr>";
          for (const c of r) html += `<td>${inline(c)}</td>`;
          html += "</tr>";
        }
        html += "</tbody></table>";
        continue;
      }
      const h = t.match(/^(#{1,3})\s+(.*)$/);
      if (h) {
        flushPara();
        flushList();
        html += `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`;
        continue;
      }
      const ul = t.match(/^[-*•]\s+(.*)$/);
      const ol = t.match(/^\d+[.)]\s+(.*)$/);
      if (ul) {
        flushPara();
        if (listType !== "ul") {
          flushList();
          html += "<ul>";
          listType = "ul";
        }
        html += `<li>${inline(ul[1])}</li>`;
        continue;
      }
      if (ol) {
        flushPara();
        if (listType !== "ol") {
          flushList();
          html += "<ol>";
          listType = "ol";
        }
        html += `<li>${inline(ol[1])}</li>`;
        continue;
      }
      if (t.startsWith("&gt;")) {
        flushPara();
        flushList();
        html += `<blockquote>${inline(t.replace(/^&gt;\s?/, ""))}</blockquote>`;
        continue;
      }
      flushList();
      para.push(t);
    }
    flushPara();
    flushList();
  });

  return html;
}
