import {AppError} from './domain.mjs';
import {normalizeCandidates} from '../spikes/pinterest-g1/pins.mjs';
import {imageKey,BOARD_NAME_LIMIT} from './exports.mjs';

async function visit(client,connection,url,signal){
  signal.throwIfAborted();const page=await client.page(connection);
  await page.goto(url,{waitUntil:'domcontentloaded',timeout:35000});await client.checkAccess(page);
  await page.locator('[data-test-id="header-profile"]').waitFor({state:'attached',timeout:12000}).catch(()=>{});
  await client.checkAccess(page);await client.requireIdentity(connection);signal.throwIfAborted();return page;
}
async function boardInfo(client,connection,expected,signal){
  const page=await visit(client,connection,expected.url,signal);
  const header=page.locator('[data-test-id="board-header"]');await header.waitFor({state:'visible',timeout:15000});
  const info=await header.evaluate(el=>{const marker=el.querySelector('[data-test-id="secret-board-icon-label"]'),rect=marker?.getBoundingClientRect(),style=marker&&getComputedStyle(marker);return {name:el.querySelector('h1')?.textContent?.trim(),secret:!!marker&&rect.width>0&&rect.height>0&&style.visibility!=='hidden'&&style.display!=='none'&&!marker.closest('[aria-hidden="true"]'),count:el.querySelector('[data-test-id="pin-count"]')?.textContent?.trim()};});
  const u=new URL(page.url()),parts=u.pathname.split('/').filter(Boolean);
  if(info.name!==expected.name||parts[0]?.toLowerCase()!==connection.username?.toLowerCase()||parts.length!==2)throw new AppError('Открыта другая доска или её имя изменилось',409);
  return {page,board:{url:page.url(),name:info.name,secret:info.secret,username:parts[0]},count:info.count};
}
async function findBoard(client,connection,name,signal){
  const page=await visit(client,connection,'https://www.pinterest.com/'+connection.username+'/_saved/',signal);
  // Profile suggestions render before the real board tiles. Do not mistake
  // that intermediate screen for an empty list of existing boards.
  await page.getByRole('button',{name:/^(Edit|Изменить)$/i,exact:true}).first().waitFor({state:'visible',timeout:15000});
  let previous=0,stalled=0;
  for(let i=0;i<22;i++){
    signal.throwIfAborted();await client.checkAccess(page);
    const matches=page.getByText(name,{exact:true});
    if(await matches.count()>1)throw new AppError('Несколько досок с таким именем. Автоматический выбор остановлен.',409);
    if(await matches.count()===1){
      const href=await matches.evaluate(el=>el.closest('a[href]')?.getAttribute('href'));
      if(!href)throw new AppError('Не удалось установить адрес доски по видимой карточке',409);
      return new URL(href,page.url()).href;
    }
    const cards=await page.locator('a[href]').count();stalled=cards===previous?stalled+1:0;previous=cards;
    if(stalled>=5)return null;
    await page.evaluate(()=>window.scrollBy(0,window.innerHeight*.85));await page.waitForTimeout(600);
  }
  throw new AppError('Список досок не удалось сверить до конца. Новая доска не создавалась.',409);
}
async function openPicker(client,connection,pin,signal){
  const page=await visit(client,connection,pin.pinUrl,signal);
  const hero=page.locator('[data-test-id="closeup-image"] img,[data-test-id="closeup-image-main"] img,img[data-test-id="closeup-image-main"]');
  await hero.first().waitFor({state:'visible',timeout:15000});
  const sources=await hero.evaluateAll(images=>images.map(i=>i.currentSrc||i.src));
  if(!sources.some(url=>imageKey(url)===imageKey(pin.imageUrl)))throw new AppError('Изображение исходного пина изменилось. Сохранение остановлено.',409);
  const dropdown=page.locator('[data-test-id="PinBetterSaveDropdown"]');
  if(await dropdown.count()!==1)throw new AppError('Неоднозначный выбор доски Pinterest',409);
  await dropdown.click();const picker=page.locator('[data-test-id="board-picker-flyout"]');await picker.locator('input').waitFor({state:'visible',timeout:12000});await client.checkAccess(page);signal.throwIfAborted();return {page,picker};
}
export async function ensureExportBoard(client,connection,expected,firstPin,{signal,readOnly,beforeCreate}){
  if(typeof expected.name!=='string'||!expected.name.trim()||expected.name.length>BOARD_NAME_LIMIT)throw new AppError('Название доски Pinterest должно содержать не более 50 символов. Запись не начиналась.',409);
  if(expected.url)return (await boardInfo(client,connection,expected,signal)).board;
  let url=await findBoard(client,connection,expected.name,signal);
  if(!url){
    if(readOnly)throw new AppError('Адрес доски после прошлой попытки не установлен. Повторное создание заблокировано; нужна ручная сверка.',409);
    const {page,picker}=await openPicker(client,connection,firstPin,signal);
    await picker.getByText(/^(Create board|Создать доску)$/i).click();
    const dialog=page.getByRole('dialog',{name:/^(Create board|Создать доску)$/i});await dialog.waitFor({state:'visible'});
    await dialog.locator('#boardEditName').fill(expected.name);await dialog.locator('input#secret[type="checkbox"]').check();
    if(!await dialog.locator('#secret').isChecked()||await dialog.locator('#boardEditName').inputValue()!==expected.name)throw new AppError('Не подтверждены имя и секретность новой доски',409);
    const create=dialog.getByRole('button',{name:/^(Create|Создать)$/i,exact:true});
    if(!await create.isEnabled()||await dialog.getByText(/Please enter no more than 50 characters\.?/i).isVisible())throw new AppError('Pinterest не разрешил создание доски. Проверьте название; запись не начиналась.',409);
    await client.checkAccess(page);signal.throwIfAborted();await beforeCreate();
    await create.click();
    await dialog.waitFor({state:'hidden',timeout:15000});
    url=await findBoard(client,connection,expected.name,signal);
    if(!url)throw new AppError('Создание доски могло завершиться, но адрес не подтверждён. Автоматического повтора нет.',409);
  }
  return (await boardInfo(client,connection,{...expected,url},signal)).board;
}
export async function readExportBoard(client,connection,expected,signal){
  const {page,board,count}=await boardInfo(client,connection,expected,signal);
  if(!board.secret)throw new AppError('Доска перестала быть секретной. Запись остановлена.',409);
  const number=count?.match(/^(\d[\d ,\u00a0]*)\s*(?:Pins?|пин(?:а|ов)?)\b/iu),expectedCount=number?Number(number[1].replace(/[ ,\u00a0]/g,'')):null;
  if(expectedCount===0)return {board,pins:[],complete:true};
  const grid=page.locator('[data-test-id="board-feed"] [data-test-id="base-board-pin-grid"]');await grid.waitFor({state:'attached',timeout:12000});
  const pins=new Map();let stalled=0;
  for(let i=0;i<40;i++){
    signal.throwIfAborted();await client.checkAccess(page);
    const raw=await grid.evaluate(el=>[...el.querySelectorAll('a[href]')].map(a=>{const u=new URL(a.href,location.href),m=u.pathname.match(/^\/pin\/([1-9]\d*)\/?$/),img=a.querySelector('img');return m&&img?{pinId:m[1],pinUrl:u.origin+'/pin/'+m[1]+'/',imageUrl:img.currentSrc||img.src,alt:img.alt}:null;}).filter(Boolean));
    const before=pins.size;for(const pin of normalizeCandidates(raw).pins)pins.set(pin.pinId,pin);
    if(expectedCount!==null&&pins.size===expectedCount)return {board,pins:[...pins.values()],complete:true};
    stalled=before===pins.size?stalled+1:0;if(stalled>=5||pins.size>=500)break;
    await page.evaluate(()=>window.scrollBy(0,window.innerHeight*.85));await page.waitForTimeout(650);
  }
  return {board,pins:[...pins.values()],complete:false};
}
export async function saveExportPin(client,connection,board,pin,{signal,beforeWrite}){
  // Recheck privacy and ownership immediately before each destination choice.
  const verified=await boardInfo(client,connection,board,signal);if(!verified.board.secret)throw new AppError('Секретность доски не подтверждена',409);
  const {page,picker}=await openPicker(client,connection,pin,signal);
  await picker.locator('input').fill(board.name);
  const row=picker.locator('[data-test-id^="board-row-"]').filter({has:page.getByText(board.name,{exact:true})});
  await row.waitFor({state:'visible',timeout:12000});
  if(await row.count()!==1||await row.getAttribute('data-test-id')!=='board-row-'+board.name)throw new AppError('Доска в меню сохранения неоднозначна',409);
  const save=row.getByRole('button',{name:/^(save|сохранить)$/i,exact:true});
  if(await save.count()!==1)throw new AppError('Не найдена однозначная кнопка сохранения в нужную доску',409);
  await client.checkAccess(page);signal.throwIfAborted();await beforeWrite();await save.click();
  await picker.waitFor({state:'hidden',timeout:15000});
}
