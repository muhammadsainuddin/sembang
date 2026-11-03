// Fake email delivery for browser QA only. Never connects to an SMTP server.
import {createApp} from '../server.js';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
const dir=mkdtempSync(path.join(tmpdir(),'sembang-otp-browser-'));
const instance=createApp({dataDir:dir,config:{requireEmailVerification:true},sendVerification:async ({code})=>console.log(`QA verification code: ${code}`)});
await new Promise(resolve=>instance.http.listen(3002,'127.0.0.1',resolve));
console.log('QA only: http://127.0.0.1:3002 — email is simulated; data is temporary.');
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,async()=>{await instance.close();rmSync(dir,{recursive:true,force:true});process.exit(0);});
