import {randomBytes,scrypt,timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';
import {AppError} from './domain.mjs';

const derive=promisify(scrypt),options={N:32768,r:8,p:1,maxmem:64*1024*1024};
export const SESSION_MS=30*60*1000;
export async function setLocalPassword(store,connectionId,password){
  if(!store.get('connection',connectionId))throw new AppError('Подключение не найдено',404);
  if(typeof password!=='string'||password.length<12||password.length>256)throw new AppError('Пароль PMA должен содержать от 12 до 256 символов');
  const salt=randomBytes(16).toString('hex'),hash=(await derive(password,salt,32,options)).toString('hex');
  store.save('local-credential',{id:'local-password-'+connectionId,connectionId,salt,hash,failures:0,blockedUntil:0});
}
export class LocalAuth {
  constructor(store,{now=Date.now,onLock=()=>{}}={}){this.store=store;this.now=now;this.onLock=onLock;this.session=null;this.verifying=false;}
  protected(id){return !!this.store.get('local-credential','local-password-'+id);}
  current(){if(this.session&&(this.session.expiresAt<=this.now()||this.store.get('local-credential','local-password-'+this.session.connectionId)?.hash!==this.session.credentialHash))this.lock();return this.session;}
  lock(){const previous=this.session;this.session=null;if(previous)this.onLock(previous.connectionId);}
  fromRequest(req){const value=req.headers.cookie?.split(';').map(v=>v.trim()).find(v=>v.startsWith('pma-session='))?.slice(12);const session=this.current();return session&&session.token===value?session:null;}
  owner(session){return session&&this.current()===session?session.connectionId:null;}
  async verify(connectionId,password){
    if(this.verifying)throw new AppError('Проверка пароля уже выполняется',429);
    const c=this.store.get('local-credential','local-password-'+connectionId);
    if(!c)throw new AppError('Сначала задайте локальный пароль на этом ПК командой npm run password',409);
    if(c.blockedUntil>this.now())throw new AppError('Слишком много попыток. Повторите через пять минут.',429);
    if(typeof password!=='string'||password.length>256)throw new AppError('Введите локальный пароль PMA',401);
    this.verifying=true;
    try{
      const hash=await derive(password,c.salt,32,options);
      if(!timingSafeEqual(hash,Buffer.from(c.hash,'hex'))){
        const failures=(c.failures||0)+1;
        this.store.save('local-credential',{...c,failures:failures>=5?0:failures,blockedUntil:failures>=5?this.now()+5*60000:0});
        throw new AppError('Неверный локальный пароль PMA',401);
      }
      this.store.save('local-credential',{...c,failures:0,blockedUntil:0});
    }finally{this.verifying=false;}
  }
  unlock(connectionId){this.lock();return this.session={connectionId,credentialHash:this.store.get('local-credential','local-password-'+connectionId)?.hash,token:randomBytes(32).toString('base64url'),expiresAt:this.now()+SESSION_MS};}
  cookie(session){return 'pma-session='+(session?.token||'')+'; HttpOnly; SameSite=Strict; Path=/; Max-Age='+(session?SESSION_MS/1000:0);}
}
