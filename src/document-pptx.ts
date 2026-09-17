import { packZip, type PackEntry } from "./document-package.js";
import { xmlSafe, type SlideSpec } from "./document-write.js";

/**
 * A slide deck written from titles and bullet points, with a picture the assistant made earlier
 * able to take a slide of its own. The deck carries the one master, layout and theme PowerPoint
 * insists on; beyond that it is deliberately plain, because a deck that looks like the person's own
 * template is their job and a guess here would only be in the way.
 */
const slideNamespaces =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
  + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
  + 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
/** A slide is ten inches by seven and a half, counted in the hundred-thousandths Office uses. */
const slideWidth = 9144000, slideHeight = 6858000;
export const pictureKinds: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

const frame = (x: number, y: number, cx: number, cy: number): string =>
  `<a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/>`;
/** One text box: its place on the slide, and one paragraph per line given. */
function textShape(id: number, name: string, place: string, lines: string[], size: number, placeholder = ""): string {
  const paragraphs = lines.map((line) => `<a:p><a:r><a:rPr lang="en-US" sz="${size}"/><a:t>${xmlSafe(line)}</a:t></a:r></a:p>`);
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>`
    + `<p:nvPr>${placeholder}</p:nvPr></p:nvSpPr>`
    + `<p:spPr><a:xfrm>${place}</a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>`
    + `<p:txBody><a:bodyPr/><a:lstStyle/>${paragraphs.join("") || "<a:p/>"}</p:txBody></p:sp>`;
}
/** The picture shape, pointing at the file this slide's own relationship list names. */
const pictureShape = (): string =>
  '<p:pic><p:nvPicPr><p:cNvPr id="4" name="Picture"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>'
  + '<p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>'
  + `<p:spPr><a:xfrm>${frame(1143000, 1600200, 6858000, 4114800)}</a:xfrm>`
  + '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>';

/** One slide: its title, its bullet points, and a picture when the slide was given one. */
export function slideXml(slide: SlideSpec): string {
  const shapes = [textShape(2, "Title", frame(838200, 365125, 7772400, 1143000),
    slide.title ? [slide.title] : [], 3200, '<p:ph type="ctrTitle"/>')];
  if (slide.picture) shapes.push(pictureShape());
  else if (slide.bullets.length)
    shapes.push(textShape(3, "Body", frame(838200, 1825625, 7772400, 4114800), slide.bullets, 1800, '<p:ph type="body" idx="1"/>'));
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld ${slideNamespaces}><p:cSld><p:spTree>`
    + '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>'
    + `${shapes.join("")}</p:spTree></p:cSld></p:sld>`;
}
/** The speaker's notes for one slide, which the reader gives back under "Notes:". */
export function notesXml(notes: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:notes ${slideNamespaces}><p:cSld><p:spTree>`
    + '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>'
    + textShape(2, "Notes", frame(0, 0, slideWidth, slideHeight), notes.split(/\n+/).filter(Boolean), 1200)
    + "</p:spTree></p:cSld></p:notes>";
}

/** A complete deck. Pictures are handed in as bytes the caller already read and checked. */
export function buildPptx(slides: SlideSpec[], pictures: Map<string, Buffer> = new Map()): Buffer {
  const usable = slides.length ? slides : [{ title: "", bullets: [], picture: "", notes: "" }];
  const media: PackEntry[] = [], parts: PackEntry[] = [];
  for (const [at, slide] of usable.entries()) {
    const bytes = slide.picture ? pictures.get(slide.picture) : undefined;
    const name = bytes ? `image${at + 1}.${slide.picture.split(".").pop()?.toLowerCase() ?? "png"}` : "";
    if (bytes && name) media.push({ name: `ppt/media/${name}`, body: bytes });
    parts.push({ name: `ppt/slides/slide${at + 1}.xml`, body: slideXml({ ...slide, picture: name ? slide.picture : "" }) });
    parts.push({ name: `ppt/slides/_rels/slide${at + 1}.xml.rels`, body: slideRels(at + 1, name, Boolean(slide.notes)) });
    if (slide.notes) parts.push({ name: `ppt/notesSlides/notesSlide${at + 1}.xml`, body: notesXml(slide.notes) });
  }
  return packZip([
    { name: "[Content_Types].xml", body: contentTypes(usable, media) },
    { name: "_rels/.rels", body: rootRels },
    { name: "ppt/presentation.xml", body: presentationXml(usable.length) },
    { name: "ppt/_rels/presentation.xml.rels", body: presentationRels(usable.length) },
    { name: "ppt/slideMasters/slideMaster1.xml", body: master },
    { name: "ppt/slideMasters/_rels/slideMaster1.xml.rels", body: masterRels },
    { name: "ppt/slideLayouts/slideLayout1.xml", body: layout },
    { name: "ppt/slideLayouts/_rels/slideLayout1.xml.rels", body: layoutRels },
    { name: "ppt/theme/theme1.xml", body: theme },
    ...parts, ...media,
  ]);
}
function slideRels(number: number, picture: string, notes: boolean): string {
  const extras = [
    picture ? `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${picture}"/>` : "",
    notes ? `<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide${number}.xml"/>` : "",
  ];
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>'
    + `${extras.join("")}</Relationships>`;
}
function contentTypes(slides: SlideSpec[], media: PackEntry[]): string {
  const kinds = new Set(media.map((entry) => entry.name.split(".").pop()!.toLowerCase()));
  const defaults = [...kinds].map((kind) => `<Default Extension="${kind}" ContentType="${pictureKinds[kind] ?? "image/png"}"/>`);
  const slideParts = slides.flatMap((slide, at) => [
    `<Override PartName="/ppt/slides/slide${at + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`,
    slide.notes ? `<Override PartName="/ppt/notesSlides/notesSlide${at + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>` : "",
  ]);
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + `<Default Extension="xml" ContentType="application/xml"/>${defaults.join("")}`
    + '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>'
    + '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>'
    + '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>'
    + '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>'
    + `${slideParts.join("")}</Types>`;
}
const rootRels =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>';
function presentationXml(count: number): string {
  const listed = Array.from({ length: count }, (_value, at) => `<p:sldId id="${256 + at}" r:id="rId${at + 2}"/>`);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation ${slideNamespaces}>`
    + '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>'
    + `<p:sldIdLst>${listed.join("")}</p:sldIdLst>`
    + `<p:sldSz cx="${slideWidth}" cy="${slideHeight}"/><p:notesSz cx="${slideHeight}" cy="${slideWidth}"/></p:presentation>`;
}
function presentationRels(count: number): string {
  const slides = Array.from({ length: count }, (_value, at) =>
    `<Relationship Id="rId${at + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${at + 1}.xml"/>`);
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>'
    + `${slides.join("")}<Relationship Id="rId${count + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/></Relationships>`;
}
const emptyTree =
  '<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld>'
  + '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>';
const master = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldMaster ${slideNamespaces}>${emptyTree}`
  + '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>';
const masterRels =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>'
  + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>';
const layout = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldLayout ${slideNamespaces} type="titleOnly">`
  + `${emptyTree.replace(/<p:clrMap[^>]*\/>/, "")}</p:sldLayout>`;
const layoutRels =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>';
const colour = (name: string, value: string): string => `<a:${name}><a:srgbClr val="${value}"/></a:${name}>`;
const fill = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
const theme =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Branch">'
  + '<a:themeElements><a:clrScheme name="Branch">'
  + '<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>'
  + colour("dk2", "44546A") + colour("lt2", "E7E6E6") + colour("accent1", "4472C4") + colour("accent2", "ED7D31")
  + colour("accent3", "A5A5A5") + colour("accent4", "FFC000") + colour("accent5", "5B9BD5") + colour("accent6", "70AD47")
  + colour("hlink", "0563C1") + colour("folHlink", "954F72") + "</a:clrScheme>"
  + '<a:fontScheme name="Branch"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>'
  + '<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>'
  + `<a:fmtScheme name="Branch"><a:fillStyleLst>${fill.repeat(3)}</a:fillStyleLst>`
  + `<a:lnStyleLst>${`<a:ln w="6350">${fill}</a:ln>`.repeat(3)}</a:lnStyleLst>`
  + `<a:effectStyleLst>${"<a:effectStyle><a:effectLst/></a:effectStyle>".repeat(3)}</a:effectStyleLst>`
  + `<a:bgFillStyleLst>${fill.repeat(3)}</a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;
