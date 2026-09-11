const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );

/** The sample website is a small renderer, separate from scheduling and publication. */
export function greetingHtml(title, members) {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)}</title>
<style>body{margin:0;background:#f7f5ef;color:#272f2b;font:17px/1.8 system-ui,sans-serif}main{max-width:1050px;margin:60px auto;padding:24px}header{text-align:center;margin-bottom:50px}h1{font-size:40px;letter-spacing:3px}header p{color:#67706b}.people{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:28px}article{background:white;border:1px solid #e6e6dc;border-radius:16px;padding:22px}img{width:100%;aspect-ratio:1;object-fit:cover;border-radius:12px}h2{font-size:20px;margin:14px 0 4px}article p{font-size:16px;white-space:pre-wrap}footer{text-align:center;color:#737d75;margin-top:55px}</style>
<main><header><p>致亲爱的老师</p><h1>${escape(title)}</h1><p>每一份祝福，都有我们的心意。</p></header><section class="people">${members.map((m) => `<article><img src="${escape(m.imagePath)}" alt="${escape(m.name)}的虚拟形象"><h2>${escape(m.name)}</h2><p>${escape(m.blessing)}</p></article>`).join("")}</section><footer>感谢一路以来的教导与陪伴。</footer></main></html>`;
}
