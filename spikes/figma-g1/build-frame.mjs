// Portable core for the G1 technical image import.
// Creates separate editable image nodes and source links, never a flattened board.
export async function buildFrame(figma, payload) {
  const createdNodeIds = [];
  const remember = node => { createdNodeIds.push(node.id); return node; };
  const [background, bodyStyle, linkStyle] = payload.useLibraryStyles === false ? [null, {fontName:{family:'Inter',style:'Regular'},id:null}, {fontName:{family:'Inter',style:'Regular'},id:null}] : await Promise.all([
    figma.variables.importVariableByKeyAsync('63a99f708b260ccc6fa8cb069cf4b2bec8b91be5'),
    figma.importStyleByKeyAsync('dd16ffab542d022b9a2d78275ed222c2cb4646b4'),
    figma.importStyleByKeyAsync('6fbe5a142218ceefd0caa5b9183bc64fb90b262f')
  ]);
  const fonts = [{ family: 'Inter', style: 'Bold' }, bodyStyle.fontName, linkStyle.fontName];
  await Promise.all([...new Map(fonts.map(f => [f.family + '/' + f.style, f])).values()].map(f => figma.loadFontAsync(f)));
  const stack = (direction, name) => {
    const node = remember(typeof figma.createAutoLayout === 'function' ? figma.createAutoLayout(direction) : figma.createFrame());
    node.layoutMode = direction;
    node.primaryAxisSizingMode = 'AUTO';
    node.counterAxisSizingMode = 'AUTO';
    node.name = name;
    node.fills = [];
    return node;
  };
  const text = (parent, name, value, width, style, bold = false) => {
    const node = remember(figma.createText());
    node.name = name;
    node.fontName = bold ? { family: 'Inter', style: 'Bold' } : style.fontName;
    if (style?.id) node.textStyleId = style.id;
    node.characters = value;
    if (bold) node.fontSize = 32;
    node.resize(width, Math.max(20, node.height));
    node.textAutoResize = 'HEIGHT';
    parent.appendChild(node);
    return node;
  };
  const page = figma.currentPage;
  const maxX = page.children.reduce((v, n) => Math.max(v, n.x + n.width), 0);
  const root = stack('VERTICAL', payload.name);
  if(payload.onRoot)await payload.onRoot(root);
  root.x = maxX + 160; root.y = 0;
  root.paddingTop = 40; root.paddingRight = 40; root.paddingBottom = 40; root.paddingLeft = 40;
  root.itemSpacing = 28;
  root.fills = [background ? figma.variables.setBoundVariableForPaint({ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }, 'color', background) : {type:'SOLID',color:{r:1,g:1,b:1}}];
  root.resize(1776, 100);
  root.counterAxisSizingMode = 'FIXED';
  if ('placeholder' in root) root.placeholder = true;
  text(root, 'Задание', payload.query, 1696, null, true);
  text(root, 'Статус проверки', payload.technicalProbe ? 'G1 · ' + payload.pins.length + ' технических кандидатов Pinterest. Отдельные изображения и ссылки. Это не утверждённый мудборд проекта.' : 'Pinterest · Выбрано ' + payload.pins.length + ' изображений. Источники сохранены под каждой карточкой.', 1696, bodyStyle);
  const imageNodeIds = [];
  const sourceLinkNodeIds = [];
  for (let index = 0; index < payload.pins.length; index += 5) {
    const row = stack('HORIZONTAL', 'Ряд ' + (Math.floor(index / 5) + 1));
    row.itemSpacing = 24; root.appendChild(row);
    for (const [offset, pin] of payload.pins.slice(index, index + 5).entries()) {
      const card = stack('VERTICAL', 'Референс ' + pin.pinId);
      card.itemSpacing = 10;
      card.resize(320, 100); card.counterAxisSizingMode = 'FIXED';
      row.appendChild(card);
      const image = remember(figma.createRectangle());
      image.name = 'Изображение · ' + pin.pinId;
      image.resize(320, 260);
      image.fills = [];
      card.appendChild(image);
      imageNodeIds.push(image.id);
      text(card, 'Описание · ' + pin.pinId, String(index + offset + 1).padStart(2, '0') + ' · ' + pin.altText.slice(0, 170), 320, bodyStyle);
      const link = text(card, 'Источник · ' + pin.pinId, 'Открыть пин Pinterest ↗', 320, linkStyle);
      link.setRangeHyperlink(0, link.characters.length, { type: 'URL', value: pin.pinUrl });
      sourceLinkNodeIds.push(link.id);
    }
  }
  return { rootNodeId: root.id, pageId: page.id, createdNodeIds, imageNodeIds, sourceLinkNodeIds,
    importedStyleIds: [bodyStyle.id, linkStyle.id].filter(Boolean), importedVariableIds: background ? [background.id] : [],
    fonts: fonts, count: payload.pins.length, size: {width:root.width,height:root.height} };
}
