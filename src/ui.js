import { invoke } from "@tauri-apps/api/core";
import { ic } from "./icons.js";
import { t, has, errCode, stripErr } from "./i18n.js";

document.addEventListener("contextmenu", (e) => e.preventDefault());

document.addEventListener("keydown", (e) => {
  if (e.key === "F12") e.preventDefault();
  if (e.ctrlKey && e.shiftKey && ["I", "i", "J", "j", "C", "c"].includes(e.key)) e.preventDefault();
  if (e.ctrlKey && ["u", "s"].includes(e.key.toLowerCase())) e.preventDefault();
});

export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function dismissSplash() {
  const el = document.getElementById("splash");
  if (!el) return;
  el.style.opacity = "0";
  setTimeout(() => el.remove(), 220);
}

export function toast(msg, kind = "ok", detail = "") {
  let zone = document.querySelector(".toast-zone");
  if (!zone) {
    zone = document.createElement("div");
    zone.className = "toast-zone";
    document.body.appendChild(zone);
  }
  const t = document.createElement("div");
  t.className = `toast ${kind}`;
  t.innerHTML = `<span class="t-ic">${ic(kind === "ok" ? "check" : "alert", 16)}</span>
    <span class="t-body">${esc(msg)}${detail ? `<span class="detail">${esc(detail)}</span>` : ""}</span>`;
  zone.appendChild(t);
  setTimeout(() => t.remove(), detail ? 5200 : 3200);
}

function runAttr(expr, event) {
  try {
    const open = expr.indexOf("(");
    if (open < 0 || !expr.trimEnd().endsWith(")")) return;
    let fn = window;
    for (const seg of expr.slice(0, open).trim().split(".")) fn = fn?.[seg];
    if (typeof fn !== "function") return;
    const src = expr.slice(open + 1, expr.trimEnd().length - 1).trim();
    const args = src
      ? src.split(/\s*,\s*/).map((a) => {
          if (a === "event") return event;
          const m = a.match(/^'([^']*)'$/);
          if (m) return m[1];
          return JSON.parse(a);
        })
      : [];
    fn(...args);
  } catch (e) {
    console.warn("attr handler error:", expr, e);
  }
}

export function installDelegation() {
  document.addEventListener("click", (e) => {
    const el = e.target.closest("[click]");
    if (!el) return;
    e.preventDefault();
    runAttr(el.getAttribute("click") || "", e);
  });
  document.addEventListener("keydown", (e) => {
    const el = e.target.closest("[keydown]");
    if (!el) return;
    runAttr(el.getAttribute("keydown") || "", e);
  });
  document.addEventListener("blur", (e) => {
    const el = e.target.closest("[blur]");
    if (!el) return;
    runAttr(el.getAttribute("blur") || "", e);
  }, true);
  document.addEventListener("input", (e) => {
    const el = e.target.closest("[input]");
    if (!el) return;
    runAttr(el.getAttribute("input") || "", e);
  });
  document.addEventListener("change", (e) => {
    const el = e.target.closest("[change]");
    if (!el) return;
    runAttr(el.getAttribute("change") || "", e);
  });
}

export function openConfirmModal(m) {
  document.querySelector(".cm-mask")?.remove();
  const kind = m.kind || "plain";
  const mask = document.createElement("div");
  mask.className = "cm-mask";
  mask.innerHTML = `
    <div class="cm-panel" role="alertdialog" aria-modal="true" aria-label="${esc(m.title)}">
      <div class="cm-strip ${kind}"></div>
      <div class="cm-head">
        <span class="cm-ic ${kind}">${ic(m.icon || "alert", 21)}</span>
        <div class="cm-title">${esc(m.title)}</div>
      </div>
      ${m.desc ? `<div class="cm-desc">${m.desc}</div>` : ""}
      <div class="cm-actions">
        <button class="btn-ghost cm-no">${esc(m.noLabel || t("common.cancel"))}</button>
        <button class="cm-yes ${kind}">${esc(m.yesLabel || t("common.confirm"))}</button>
      </div>
    </div>`;
  document.body.appendChild(mask);

  const panel = mask.querySelector(".cm-panel");
  const yes = mask.querySelector(".cm-yes");
  const no = mask.querySelector(".cm-no");
  const close = () => {
    document.removeEventListener("keydown", mask._key);
    mask.remove();
  };
  panel.addEventListener("click", (e) => e.stopPropagation());
  mask.addEventListener("click", close);
  no.addEventListener("click", close);
  yes.addEventListener("click", () => {
    // fireAndForget：确认后立刻关弹窗再执行（删除等可能被后台长操作阻塞的动作，
    // 结果用 toast 反馈——弹窗不长时间停留在屏幕上）
    if (m.fireAndForget) {
      close();
      try { m.onYes?.(); } catch { /* 调用方自行兜底 */ }
      return;
    }
    yes.disabled = true; no.disabled = true;
    (async () => { try { await m.onYes?.(); } finally { close(); } })();
  });
  mask._key = (e) => {
    if (e.key === "Escape") close();
    if (e.key === "Enter" && e.target === document.body && !yes.disabled) yes.click();
  };
  document.addEventListener("keydown", mask._key);
  (m.focusNo || kind === "danger" ? no : yes).focus();
}

export function openPwModal(m) {
  document.querySelector(".pw-mask")?.remove();
  const isExport = m.mode === "export" || m.mode === "exportAll";
  const title = m.mode === "export" ? t("pw.exportTitle", { name: esc(m.name) })
    : m.mode === "exportAll" ? t("pw.exportAllTitle", { count: m.count })
    : t("pw.importTitle", { count: m.files.length });
  const sub = isExport
    ? t("pw.exportSub", { path: esc(m.path) })
    : t("pw.importSub", { files: m.files.map(([n]) => esc(n)).join(t("common.listSep")) });

  const mask = document.createElement("div");
  mask.className = "pw-mask";
  // 导入：所选文件全部是明文信封时无需密码（m.allPlain 由调用方根据 pick 结果传入）
  const allPlain = m.mode === "import" && m.allPlain === true;
  const pwRowStyle = allPlain ? ' style="display:none"' : "";
  mask.innerHTML = `
    <div class="pw-panel">
      <div class="pw-title">${title}</div>
      <div class="pw-sub">${sub}</div>
      <input class="pw-input" type="password" id="pw1" placeholder="${isExport ? t("pw.setPw") : t("pw.pw")}" autocomplete="off"${pwRowStyle}>
      ${isExport ? `<input class="pw-input" type="password" id="pw2" placeholder="${t("pw.pwAgain")}" autocomplete="off"${pwRowStyle}>` : ""}
      ${isExport ? `<div class="pw-hint pw-plain-hint" style="display:none">${esc(t("pw.plainHint"))}</div>` : ""}
      ${allPlain ? `<div class="pw-hint">${esc(t("pw.importPlainHint"))}</div>` : ""}
      <div class="pw-err"></div>
      <div class="pw-actions">
        <button class="btn-ghost pw-cancel">${t("common.cancel")}</button>
        <button class="btn-primary pw-go has-ic">${allPlain ? ic("lockOpen", 14) + " " + t("pw.importPlainGo") : isExport ? ic("lock", 14) + " " + t("pw.encryptExport") : ic("lockOpen", 14) + " " + t("pw.decryptImport")}</button>
      </div>
    </div>`;
  document.body.appendChild(mask);

  const panel = mask.querySelector(".pw-panel");
  const errEl = mask.querySelector(".pw-err");
  const go = mask.querySelector(".pw-go");
  const input1 = mask.querySelector("#pw1");
  const input2 = mask.querySelector("#pw2");
  panel.addEventListener("click", (e) => e.stopPropagation());
  mask.addEventListener("click", () => mask.remove());
  mask.querySelectorAll(".pw-cancel").forEach((b) => b.addEventListener("click", () => mask.remove()));
  const key = (e) => {
    if (e.key === "Escape") mask.remove();
    if (e.key === "Enter") confirm();
  };
  [input1, input2].forEach((i) => i?.addEventListener("keydown", key));
  input1.focus();

  // 导出：密码留空 = 明文导出（按钮与提示会随之切换）；加密密码仍要求 ≥6 位
  const hintEl = mask.querySelector(".pw-plain-hint");
  const updateGo = () => {
    if (!isExport) return;
    const plain = !(input1?.value || "").length;
    go.innerHTML = plain ? ic("alert", 14) + " " + esc(t("pw.plainGo")) : ic("lock", 14) + " " + esc(t("pw.encryptExport"));
    if (hintEl) hintEl.style.display = plain ? "" : "none";
  };
  input1?.addEventListener("input", updateGo);
  updateGo();

  async function confirm() {
    const pw1 = input1?.value || "";
    const pw2 = input2?.value;
    if (!allPlain && pw1.length > 0 && pw1.length < 6) return (errEl.textContent = t("pw.errMinLen"));
    if (!allPlain && pw1.length === 0) return (errEl.textContent = t("pw.errMinLen"));
    if (pw2 !== undefined && pw2 !== null && pw1 !== pw2) return (errEl.textContent = t("pw.errMismatch"));
    go.disabled = true;
    try {
      if (m.mode === "export") {
        const r = await invoke("export_finalize", { path: m.path, id: m.id, password: pw1 });
        toast(t("pw.exportedToast", { path: r.path }), "ok", t("pw.exportedToastDetail"));
        m.onDone?.(r);
      } else if (m.mode === "exportAll") {
        const r = await invoke("export_all_finalize", { path: m.path, password: pw1 });
        toast(t("pw.exportedAllToast", { count: r.count }), "ok", r.path);
        m.onDone?.(r);
      } else {
        let report = await invoke("import_sealed", { files: m.files, password: pw1 });
        if (m.preErrors?.length) {
          report.errors = [...m.preErrors, ...(report.errors || [])];
        }
        const wrongPw = (report.errors || []).some((e) => errCode(e) === "wrong_password" || String(e).includes("密码错误"));
        if (wrongPw) { errEl.textContent = t("pw.errWrong"); go.disabled = false; return; }
        m.onDone?.(report);
      }
      mask.remove();
    } catch (e) {
      errEl.textContent = stripErr(e);
      go.disabled = false;
    }
  }
  go.addEventListener("click", confirm);
}

export function openProviderModal(m) {
  document.querySelector(".pv-mask")?.remove();
  const mask = document.createElement("div");
  mask.className = "pv-mask";
  const displayOf = (p) => has(`prov.${p.id}`) ? t(`prov.${p.id}`) : p.display;
  let mode = m.browser === false ? "window" : "browser";
  mask.innerHTML = `
    <div class="pv-panel">
      <div class="pv-title">${t("prov.title")}</div>
      <div class="pv-sub">${t("prov.sub")}</div>
      <div class="pv-modes" role="radiogroup" aria-label="${t("prov.modeLabel")}">
        <button class="pv-mode" role="radio" aria-checked="false" data-mode="browser">${ic("browser", 14)} <span>${t("prov.modeBrowser")}</span></button>
        <button class="pv-mode" role="radio" aria-checked="false" data-mode="window">${ic("browser", 14)} <span>${t("prov.modeWindow")}</span></button>
      </div>
      <div class="pv-hint">${ic("browser", 13)}<span class="pv-hint-text"></span></div>
      <div class="pv-list">
        ${(m.providers || []).map((p) => `
          <button class="pv-item" data-id="${esc(p.id)}">
            <span class="pv-name">${esc(displayOf(p))}</span>
            <span class="pv-arrow">→</span>
          </button>`).join("")}
      </div>
      <div class="pv-actions"><button class="btn-ghost pv-cancel">${t("common.cancel")}</button></div>
    </div>`;
  document.body.appendChild(mask);
  const onKey = (e) => { if (e.key === "Escape") close(); };
  const close = () => { mask.remove(); document.removeEventListener("keydown", onKey); };
  const hintEl = mask.querySelector(".pv-hint-text");
  const modeBtns = Array.from(mask.querySelectorAll(".pv-mode"));
  const syncMode = () => {
    for (const b of modeBtns) {
      const on = b.dataset.mode === mode;
      b.classList.toggle("on", on);
      b.setAttribute("aria-checked", on ? "true" : "false");
    }
    if (hintEl) hintEl.textContent = t(mode === "browser" ? "prov.viaBrowser" : "prov.viaWindow");
  };
  for (const b of modeBtns) b.addEventListener("click", () => { mode = b.dataset.mode; syncMode(); });
  syncMode();
  mask.querySelectorAll(".pv-item").forEach((b) => {
    b.addEventListener("click", () => {
      const browser = mode === "browser";
      close();
      m.onPick?.(b.dataset.id, browser);
    });
  });
  mask.querySelector(".pv-cancel").addEventListener("click", close);
  document.addEventListener("keydown", onKey);
  const first = mask.querySelector(".pv-item");
  if (first) first.focus();
}

export function openGroupModal(m) {
  document.querySelector(".pv-mask")?.remove();
  const mask = document.createElement("div");
  mask.className = "pv-mask";
  const cur = (m.current || "").trim();
  const itemOf = (g, label, isCur) => `
    <button class="pv-item gm-item" data-g="${g ? esc(JSON.stringify(g)) : ""}">
      <span class="pv-name">${ic("folder", 14)} <span class="gm-gname">${esc(label)}</span></span>
      ${isCur ? `<span class="gm-cur">${ic("check", 13)}</span>` : `<span class="pv-arrow">→</span>`}
    </button>`;
  const items = [
    itemOf("", t("grp.none"), !cur),
    ...(m.groups || []).map((g) => itemOf(g, g, g === cur)),
  ].join("");
  mask.innerHTML = `
    <div class="pv-panel">
      <div class="pv-title">${t("grp.modalTitle", { name: esc(m.name) })}</div>
      <div class="pv-sub">${t("grp.modalSub")}</div>
      <div class="pv-list">${items}</div>
      <div class="gm-newrow">
        <input class="gm-input" type="text" maxlength="40" placeholder="${t("grp.newPh")}" autocomplete="off">
        <button class="btn-ghost gm-create">${t("grp.create")}</button>
      </div>
      <div class="pv-actions"><button class="btn-ghost pv-cancel">${t("common.cancel")}</button></div>
    </div>`;
  document.body.appendChild(mask);
  const onKey = (e) => { if (e.key === "Escape") close(); };
  const close = () => { mask.remove(); document.removeEventListener("keydown", onKey); };
  const input = mask.querySelector(".gm-input");
  const create = () => {
    const v = input.value.trim();
    if (!v) return;
    close();
    m.onCreate?.(v);
  };
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") create(); });
  mask.querySelector(".gm-create").addEventListener("click", create);
  mask.querySelectorAll(".gm-item").forEach((b) => {
    b.addEventListener("click", () => {
      let g = b.dataset.g;
      g = g ? JSON.parse(g) : null;
      if ((g || "").trim() === cur) { close(); return; }
      close();
      m.onPick?.(g);
    });
  });
  mask.querySelector(".pv-cancel").addEventListener("click", close);
  mask.addEventListener("click", (e) => { if (e.target === mask) close(); });
  document.addEventListener("keydown", onKey);
  input.focus();
}
