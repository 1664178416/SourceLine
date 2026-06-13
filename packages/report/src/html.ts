import type { ClaimCheck, EvidenceItem, SourceLineReport } from "@sourceline/core";
import { sanitizeReport } from "./sanitize.js";

export function renderHtmlReport(report: SourceLineReport): string {
  report = sanitizeReport(report);
  const reviewCount = report.checks.filter(isReviewStatus).length;
  const claimSections =
    report.checks.length === 0
      ? "<p>No factual claims were detected.</p>"
      : report.checks.map((check, index) => renderClaimCheck(check, index + 1)).join("\n");
  const claimNav = renderClaimNav(report);
  const filterButtons = renderFilterButtons(report, reviewCount);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>SourceLine Report</title>
  <style>
    :root { color-scheme: light; --border: #d8dee4; --muted: #59636e; --bg: #ffffff; --soft: #f6f8fa; --text: #1f2328; }
    body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.55 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { max-width: 960px; margin: 0 auto; padding: 32px 20px 48px; }
    h1 { margin: 0 0 8px; font-size: 28px; line-height: 1.2; }
    h2 { margin: 32px 0 12px; font-size: 18px; }
    h3 { margin: 0 0 12px; font-size: 16px; line-height: 1.35; }
    button { font: inherit; }
    .meta, .muted { color: var(--muted); }
    .skip-link { position: absolute; left: 16px; top: 12px; transform: translateY(-160%); border: 1px solid var(--border); border-radius: 6px; background: var(--bg); padding: 6px 10px; z-index: 1; }
    .skip-link:focus { transform: translateY(0); }
    .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(136px, 1fr)); gap: 8px; margin: 20px 0 28px; }
    .metric { border: 1px solid var(--border); border-radius: 8px; padding: 12px; background: var(--soft); }
    .metric strong { display: block; font-size: 22px; line-height: 1.1; }
    .toolbar { display: grid; gap: 10px; margin: 0 0 20px; }
    .filter-buttons, .search-row, .utility-buttons { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
    .toolbar button { border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--text); padding: 6px 10px; cursor: pointer; }
    .toolbar button[aria-pressed="true"] { border-color: #0969da; color: #0969da; background: #ddf4ff; }
    .toolbar button:focus-visible, #claim-search:focus-visible { outline: 2px solid #0969da; outline-offset: 2px; }
    .search-label { flex: 1 1 260px; }
    #claim-search { box-sizing: border-box; width: 100%; border: 1px solid var(--border); border-radius: 6px; padding: 7px 10px; font: inherit; color: var(--text); background: var(--bg); }
    #visible-count { color: var(--muted); white-space: nowrap; }
    #copy-status { min-height: 1.55em; }
    .claim-nav { border: 1px solid var(--border); border-radius: 8px; padding: 12px 16px; margin: 0 0 20px; }
    .claim-nav ol { margin: 8px 0 0; padding-left: 24px; }
    .claim-nav li { margin: 6px 0; }
    .claim { border: 1px solid var(--border); border-radius: 8px; padding: 16px; margin: 12px 0; }
    .badges { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0 16px; }
    .badge { border: 1px solid var(--border); border-radius: 999px; padding: 2px 8px; background: var(--soft); font-size: 12px; }
    .status-supported { border-color: #1a7f37; color: #1a7f37; }
    .status-partially_supported, .status-not_enough_evidence { border-color: #9a6700; color: #9a6700; }
    .status-unsupported, .status-contradicted { border-color: #cf222e; color: #cf222e; }
    ul { padding-left: 20px; }
    a { color: #0969da; }
    code { background: var(--soft); border-radius: 4px; padding: 1px 4px; }
    .evidence li { margin-bottom: 8px; }
    .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
    [hidden] { display: none !important; }
    @media print {
      :root { --border: #8c959f; --muted: #424a53; --bg: #ffffff; --soft: #ffffff; --text: #000000; }
      body { font-size: 12px; }
      main { max-width: none; padding: 0; }
      h1 { font-size: 22px; }
      h2 { break-after: avoid; }
      a { color: inherit; text-decoration: underline; }
      a[href^="http"]::after { content: " (" attr(href) ")"; overflow-wrap: anywhere; }
      .skip-link, .toolbar, #copy-status { display: none !important; }
      .summary { grid-template-columns: repeat(3, 1fr); gap: 6px; margin: 14px 0 18px; }
      .metric, .claim-nav, .claim, .badge { background: #ffffff; }
      .claim { break-inside: avoid; page-break-inside: avoid; margin: 10px 0; }
      .badges { break-after: avoid; }
    }
  </style>
</head>
<body>
  <a class="skip-link" href="#claims-heading">Skip to claims</a>
  <main id="report-content">
    <header>
      <h1>SourceLine Report</h1>
      <div class="meta">Input: ${escapeHtml(report.input.name ?? report.input.kind)}<br>Generated: ${escapeHtml(report.generatedAt)}<br>Input hash: <code>${escapeHtml(report.input.hash)}</code></div>
    </header>
    ${renderSummary(report)}
    <div class="toolbar" role="region" aria-label="Claim filters and export tools">
      <div class="filter-buttons">
        ${filterButtons}
      </div>
      <div class="search-row">
        <label class="search-label" for="claim-search">
          <span class="sr-only">Search claims and evidence</span>
          <input type="search" id="claim-search" placeholder="Search claims and evidence" autocomplete="off" aria-keyshortcuts="/">
        </label>
        <span id="visible-count" aria-live="polite">Showing ${report.summary.totalClaims} of ${report.summary.totalClaims} claims</span>
      </div>
      <div class="utility-buttons">
        <button type="button" id="copy-visible-summary" aria-label="Copy visible claims summary">Copy Visible</button>
        <button type="button" id="download-json" aria-label="Download report JSON">Download JSON</button>
        <button type="button" id="reset-view" aria-label="Reset filters and search" aria-keyshortcuts="Escape">Reset</button>
        <span id="copy-status" class="muted" aria-live="polite"></span>
      </div>
    </div>
    <h2 id="claims-heading">Claims</h2>
    ${claimNav}
    ${claimSections}
  </main>
  <script type="application/json" id="sourceline-report-data">${escapeJsonScript(JSON.stringify(report))}</script>
  <script>
    const buttons = Array.from(document.querySelectorAll("[data-filter]"));
    const claims = Array.from(document.querySelectorAll("[data-claim-status]"));
    const navItems = Array.from(document.querySelectorAll("[data-nav-for]"));
    const searchInput = document.getElementById("claim-search");
    const visibleCount = document.getElementById("visible-count");
    const copyButton = document.getElementById("copy-visible-summary");
    const downloadButton = document.getElementById("download-json");
    const resetButton = document.getElementById("reset-view");
    const copyStatus = document.getElementById("copy-status");
    const reportDataElement = document.getElementById("sourceline-report-data");
    let activeFilter = "all";

    function matchesFilter(status) {
      return (
        activeFilter === "all" ||
        status === activeFilter ||
        (activeFilter === "review" && status !== "supported")
      );
    }

    function setActiveFilter(filter) {
      activeFilter = filter;
      buttons.forEach((item) => item.setAttribute("aria-pressed", String(item.getAttribute("data-filter") === activeFilter)));
      updateClaims();
    }

    function updateClaims() {
      const query = (searchInput?.value || "").trim().toLowerCase();
      let visible = 0;

      claims.forEach((claim) => {
        const status = claim.getAttribute("data-claim-status") || "";
        const haystack = (claim.getAttribute("data-claim-search") || claim.textContent || "").toLowerCase();
        const show = matchesFilter(status) && (query.length === 0 || haystack.includes(query));
        claim.toggleAttribute("hidden", !show);
        if (show) visible += 1;
      });

      navItems.forEach((item) => {
        const target = item.getAttribute("data-nav-for");
        const claim = target ? document.getElementById(target) : null;
        item.toggleAttribute("hidden", !claim || claim.hasAttribute("hidden"));
      });

      if (visibleCount) {
        visibleCount.textContent = "Showing " + visible + " of " + claims.length + " claims";
      }
    }

    function getVisibleClaims() {
      return claims.filter((claim) => !claim.hasAttribute("hidden"));
    }

    function buildVisibleSummary() {
      const visibleClaims = getVisibleClaims();
      const lines = ["SourceLine visible claims (" + visibleClaims.length + "/" + claims.length + ")"];

      visibleClaims.forEach((claim, index) => {
        const status = claim.getAttribute("data-claim-status") || "unknown";
        const confidence = claim.getAttribute("data-claim-confidence") || "0.00";
        const text = claim.getAttribute("data-claim-text") || "";
        const explanation = claim.getAttribute("data-claim-explanation") || "";
        const risks = claim.getAttribute("data-claim-risks") || "";

        lines.push("");
        lines.push(index + 1 + ". [" + status + ", confidence " + confidence + "] " + text);
        if (risks.length > 0) {
          lines.push("Risk flags: " + risks);
        }
        if (explanation.length > 0) {
          lines.push("Explanation: " + explanation);
        }
      });

      return lines.join("\\n");
    }

    async function copyText(text) {
      if (navigator.clipboard?.writeText && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return;
      }

      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.left = "-9999px";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
    }

    function setCopyStatus(message) {
      if (!copyStatus) {
        return;
      }
      copyStatus.textContent = message;
      window.setTimeout(() => {
        if (copyStatus.textContent === message) {
          copyStatus.textContent = "";
        }
      }, 2500);
    }

    function downloadJson() {
      const rawJson = reportDataElement?.textContent || "{}";
      const blob = new Blob([rawJson + "\\n"], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "sourceline-report.json";
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    }

    function resetView() {
      if (searchInput) {
        searchInput.value = "";
      }
      setActiveFilter("all");
    }

    buttons.forEach((button) => {
      button.addEventListener("click", () => {
        setActiveFilter(button.getAttribute("data-filter") || "all");
      });
    });
    searchInput?.addEventListener("input", updateClaims);
    copyButton?.addEventListener("click", async () => {
      const visibleClaims = getVisibleClaims();
      if (visibleClaims.length === 0) {
        setCopyStatus("No visible claims");
        return;
      }

      try {
        await copyText(buildVisibleSummary());
        setCopyStatus("Copied " + visibleClaims.length + " claim" + (visibleClaims.length === 1 ? "" : "s"));
      } catch {
        setCopyStatus("Copy failed");
      }
    });
    downloadButton?.addEventListener("click", downloadJson);
    resetButton?.addEventListener("click", resetView);
    document.addEventListener("keydown", (event) => {
      const target = event.target;
      const isTyping =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable);

      if (event.key === "/" && !isTyping) {
        event.preventDefault();
        searchInput?.focus();
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        resetView();
        searchInput?.blur();
        return;
      }

      if (!isTyping) {
        const shortcutButton = buttons.find((button) => button.getAttribute("data-filter-shortcut") === event.key);
        if (shortcutButton) {
          event.preventDefault();
          setActiveFilter(shortcutButton.getAttribute("data-filter") || "all");
        }
      }
    });
    updateClaims();
  </script>
</body>
</html>
`;
}

function renderFilterButtons(report: SourceLineReport, reviewCount: number): string {
  const filters = [
    ["all", "All", report.summary.totalClaims],
    ["review", "Review", reviewCount],
    ["supported", "Supported", report.summary.supported],
    ["partially_supported", "Partial", report.summary.partiallySupported],
    ["unsupported", "Unsupported", report.summary.unsupported],
    ["contradicted", "Contradicted", report.summary.contradicted],
    ["not_enough_evidence", "No Evidence", report.summary.notEnoughEvidence]
  ] as const;

  return filters
    .map(([filter, label, count], index) => {
      const pressed = index === 0 ? "true" : "false";
      const shortcut = String(index + 1);
      return `<button type="button" data-filter="${filter}" data-filter-shortcut="${shortcut}" aria-keyshortcuts="${shortcut}" aria-pressed="${pressed}" aria-label="Show ${label} claims, shortcut ${shortcut}" title="Shortcut ${shortcut}">${label} (${count})</button>`;
    })
    .join("\n        ");
}

function renderSummary(report: SourceLineReport): string {
  const metrics = [
    ["Claims", report.summary.totalClaims],
    ["Supported", report.summary.supported],
    ["Partial", report.summary.partiallySupported],
    ["Unsupported", report.summary.unsupported],
    ["Contradicted", report.summary.contradicted],
    ["No Evidence", report.summary.notEnoughEvidence]
  ];

  return `<section class="summary" aria-labelledby="summary-heading"><h2 id="summary-heading" class="sr-only">Summary</h2>${metrics
    .map(([label, value]) => `<div class="metric"><strong>${value}</strong><span>${label}</span></div>`)
    .join("")}</section>`;
}

function renderClaimCheck(check: ClaimCheck, index: number): string {
  const riskFlags =
    check.riskFlags.length > 0
      ? `<p><strong>Risk flags:</strong> ${check.riskFlags.map((flag) => `<code>${escapeHtml(flag)}</code>`).join(" ")}</p>`
      : "";
  const evidence =
    check.evidence.length === 0
      ? "<li>No evidence available.</li>"
      : check.evidence.map(renderEvidence).join("\n");

  return `<article class="claim" id="claim-${index}" aria-labelledby="claim-${index}-heading" data-claim-status="${escapeAttribute(check.status)}" data-claim-confidence="${formatConfidence(check.confidence)}" data-claim-text="${escapeAttribute(formatDataText(check.claim.text))}" data-claim-explanation="${escapeAttribute(formatDataText(check.explanation))}" data-claim-risks="${escapeAttribute(formatDataText(check.riskFlags.join(", ")))}" data-claim-search="${escapeAttribute(buildClaimSearchText(check))}">
  <h3 id="claim-${index}-heading">${index}. ${escapeHtml(check.claim.text)}</h3>
  <div class="badges">
    <span class="badge status-${escapeHtml(check.status)}">${escapeHtml(check.status)}</span>
    <span class="badge">confidence ${formatConfidence(check.confidence)}</span>
    <span class="badge">${escapeHtml(check.claim.claimType)}</span>
    <span class="badge">${escapeHtml(check.claim.importance)}</span>
  </div>
  <p>${escapeHtml(check.explanation)}</p>
  ${riskFlags}
  <h4 id="claim-${index}-evidence-heading">Evidence</h4>
  <ul class="evidence" aria-labelledby="claim-${index}-evidence-heading">${evidence}</ul>
</article>`;
}

function renderClaimNav(report: SourceLineReport): string {
  if (report.checks.length === 0) {
    return "";
  }

  return `<nav class="claim-nav" aria-labelledby="claim-index-heading">
  <strong id="claim-index-heading">Claim Index</strong>
  <ol>
    ${report.checks
      .map((check, index) => {
        const number = index + 1;
        return `<li data-nav-for="claim-${number}"><a href="#claim-${number}">${escapeHtml(truncate(check.claim.text, 96))}</a> <span class="badge status-${escapeHtml(check.status)}">${escapeHtml(check.status)}</span></li>`;
      })
      .join("\n    ")}
  </ol>
</nav>`;
}

function renderEvidence(evidence: EvidenceItem): string {
  const title = evidence.source.title ?? evidence.source.url ?? evidence.source.path ?? evidence.source.id;
  const location = evidence.source.url ?? evidence.source.path;
  const safeHref = location ? formatSafeHref(location) : undefined;
  const linkedTitle = safeHref
    ? `<a href="${escapeAttribute(safeHref)}">${escapeHtml(title)}</a>`
    : escapeHtml(title);
  const snippet = evidence.source.snippet ? `<div class="muted">${escapeHtml(evidence.source.snippet)}</div>` : "";
  const retrieval = renderRetrieval(evidence);

  return `<li>${linkedTitle} <span class="badge">${escapeHtml(evidence.relation)} ${formatConfidence(evidence.confidence)}</span>${retrieval}${snippet}</li>`;
}

function formatSafeHref(value: string): string | undefined {
  const trimmed = value.trim();
  if (hasHrefControlCharacters(trimmed)) {
    return undefined;
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return /[\s<>]/.test(trimmed) ? undefined : trimmed;
  }
  if (!trimmed.startsWith("//") && !/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    return trimmed.replace(/\\/g, "/").replace(/</g, "%3C").replace(/>/g, "%3E");
  }

  return undefined;
}

function hasHrefControlCharacters(value: string): boolean {
  return /[\u0000-\u001f\u007f-\u009f]/.test(value);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/`/g, "&#96;");
}

function formatDataText(value: string): string {
  return stripAnsi(value)
    .replace(/[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function stripAnsi(value: string): string {
  return value
    .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

function escapeJsonScript(value: string): string {
  return value
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 1)}...`;
}

function buildClaimSearchText(check: ClaimCheck): string {
  const evidenceText = check.evidence.flatMap((evidence) => [
    evidence.source.title,
    evidence.source.url,
    evidence.source.path,
    evidence.source.publisher,
    evidence.source.snippet,
    evidence.source.retrieval?.explanation,
    ...(evidence.source.retrieval?.matchedTerms ?? []),
    evidence.relation,
    evidence.explanation
  ]);

  return [
    check.claim.text,
    check.claim.claimType,
    check.claim.importance,
    ...check.claim.searchQueries,
    check.status,
    check.explanation,
    ...check.riskFlags,
    ...evidenceText
  ]
    .filter(isPresent)
    .map(formatDataText)
    .filter(isNonEmpty)
    .join(" ");
}

function isPresent(value: string | undefined): value is string {
  return value !== undefined && value.length > 0;
}

function isNonEmpty(value: string): boolean {
  return value.length > 0;
}

function isReviewStatus(check: ClaimCheck): boolean {
  return check.status !== "supported";
}

function formatConfidence(value: number): string {
  if (!Number.isFinite(value)) {
    return "0.00";
  }

  return Math.min(1, Math.max(0, value)).toFixed(2);
}

function formatFiniteNumber(value: number, fractionDigits: number): string | undefined {
  return Number.isFinite(value) ? value.toFixed(fractionDigits) : undefined;
}

function renderRetrieval(evidence: EvidenceItem): string {
  const retrieval = evidence.source.retrieval;
  if (!retrieval) {
    return "";
  }

  const badges: string[] = [];
  const score = retrieval.score !== undefined ? formatFiniteNumber(retrieval.score, 3) : undefined;
  if (score) {
    badges.push(`<span class="badge">score ${score}</span>`);
  }
  if (retrieval.matchedTerms && retrieval.matchedTerms.length > 0) {
    badges.push(`<span class="badge">matched ${escapeHtml(retrieval.matchedTerms.join(", "))}</span>`);
  }

  const explanation = retrieval.explanation ? `<div class="muted">${escapeHtml(retrieval.explanation)}</div>` : "";
  return `${badges.length > 0 ? ` ${badges.join(" ")}` : ""}${explanation}`;
}
