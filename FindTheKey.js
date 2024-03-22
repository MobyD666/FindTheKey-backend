import {Extension} from './extension.js';
import path from 'path';

import CryptoJS from 'crypto-js';

import {StatsSpooler,StatsCounter} from './StatsSpooler.js';



// Fixed secret key for AES (you should generate a more secure key)
const SECRET_KEY = 'your-very-secure-secret-key';

class FindTheKey extends Extension
{
    constructor(config)
    {
        super();        
        this.token = config.SECRET_TOKEN;
        this.key_key = config.KEY_KEY;
       
        this.slug = 'find-the-key-1';
        this.name = 'Find the Key';

        

        if (config.SLUG != undefined) this.slug = config.SLUG;


        

        this.webhooks['extension_session.created']= async (data,req,res) =>  
        {
            if (this.debugWebHooks) console.log('New session reported by webhook',data.data.session.sessionId);
            //await this.setReasonsPreventingUnlocking(data.data.session.sessionId,'Not so fast');
            setTimeout(async ()=>{await this.tryStartGame(data.data.session.sessionId,data.data.session.config);},1000);
            
        };

        this.webhooks['action_log.created']= async (data,req,res) => 
        {
            //if (this.debugWebHooks) console.log('Action log reported by webhook',data.data.actionLog,data.data.sessionId);
            setTimeout(async ()=>{await this.processActionLog(data);},1000);
        };

        this.globalMetrics={locked_sessions:undefined};
        if (this.dead != true) setTimeout(async ()=>{await this.prepareGlobalMetrics();},5000);


    }

    sanitizeConfig(config,userData=null)
    {
      config.keyspresentedOrig=config.keyspresented; 
      if (userData?.keysPresentedDiff != 0) config.keyspresented += userData?.keysPresentedDiff;
      config.keyspresented=Math.min(config.keyspresented,100);  
      config.keyspresented=Math.max(config.keyspresented,1);  
      return (config);  
    }

    setupStats()
    {
        this.stats.addStat(new StatsCounter('keys_displayed','The total number of keys displayed to the users'));
        this.stats.addStat(new StatsCounter('keys_guessed','The total number of keys guessed by the wearers'));
        this.stats.addStat(new StatsCounter('keys_reset','The total number of key resets midgame'));
        this.stats.addStat(new StatsCounter('keys_changed','The total number of correct keys changed midgame'));
        this.stats.addStat(new StatsCounter('fake_keys_added','The total number of fake keys added midgame'));
        this.stats.addStat(new StatsCounter('fake_keys_removed','The total number of fake keys removed midgame'));        
        


        // this.stats.counters = {
        //     'keys_displayed':0,
        //     'keys_guessed':0,
        //     'keys_guessed{result="correct"}':0,
        //     'keys_guessed{result="incorrect"}':0,
        //     'keys_changed{reason="wrongguess"}':0,
        //     'keys_reset{reason="wrongguess"}':0,
        //     'keys_changed{reason="keyholder",message="silent"}':0,
        //     'keys_changed{reason="keyholder",message="logged"}':0,
        // };

        // this.stats.countersHelp={
        //     'keys_displayed':"#HELP keys_displayed The total number of keys displayed to the users\n#TYPE keys_displayed counter",
        //     'keys_guessed':"#HELP keys_guessed The total number of keys guessed by the wearers\n#TYPE keys_guessed counter",
        //     'keys_guessed{result="correct"}':"#HELP keys_guessed The total number of keys guessed by the wearers\n#TYPE keys_guessed counter",
        //     'keys_guessed{result="incorrect"}':"#HELP keys_guessed The total number of keys guessed by the wearers\n#TYPE keys_guessed counter",
        //     'keys_changed{reason="wrongguess"}':"#HELP keys_changed The total number of correct keys changed midgame\n#TYPE keys_changed counter",
        //     'keys_reset{reason="wrongguess"}':"#HELP keys_reset The total number of key resets midgame\n#TYPE keys_reset counter",            
        //     'keys_changed{reason="keyholder",message="silent"}':"#HELP keys_changed The total number of correct keys changed midgame\n#TYPE keys_changed counter",
        //     'keys_changed{reason="keyholder",message="logged"}':"#HELP keys_changed The total number of correct keys changed midgame\n#TYPE keys_changed counter",
        // };
    }

    register(app,prefix)
    {
        super.register(app,prefix);
        app.get('/'+prefix+'config', (req, res) => {  res.sendFile(path.join(process.cwd(), 'public', 'index.html')); } );
        app.get('/'+prefix+'main', (req, res) => {  res.sendFile(path.join(process.cwd(), 'public', 'index.html')); } );
        app.get('/'+prefix+'key/:keyId', (req, res) => { this.sendKey(req, res); });
        app.post('/'+prefix+'api/keycandidates',  async (req, res) => { await this.getKeyCandidates(req, res); });        
        app.post('/'+prefix+'api/guesskey',  async (req, res) => { await this.guessKey(req, res); });                
        app.post('/'+prefix+'api/restartgame',  async (req, res) => { await this.restartGame(req, res); });
        app.post('/'+prefix+'api/changekey',  async (req, res) => { await this.changeKey(req, res); });
        app.post('/'+prefix+'api/addfakekeys',  async (req, res) => { await this.addFakeKeys(req, res); });        
    }

    sendKey(req, res)
    {
        const keyId = req.params.keyId;
        const decodedKeyNumber = this.decodeKeyNumber(keyId) 
        if (decodedKeyNumber>0) 
        {
            this.stats.statsCounterInc('keys_displayed','');
            res.sendFile(path.join(process.cwd(), 'public', 'keys' ,  'key'+decodedKeyNumber+'.png'));
        }
        else
        {
            return res.status(403).send('');
        }
    }


    encodeKeyNumber(keyNumber) 
    {
        const nonce = Date.now().toString(); // Using a timestamp as a nonce
        const combinedString = `${keyNumber}:${nonce}`;
        const encryptedData = CryptoJS.AES.encrypt(combinedString, this.key_key).toString();
        const base64 = Buffer.from(encryptedData).toString('base64');
        return base64;
    }
      
    decodeKeyNumber(base64String) 
    {
        const encryptedString = Buffer.from(base64String, 'base64').toString('utf8');
        const bytes = CryptoJS.AES.decrypt(encryptedString, this.key_key);
        const decryptedString = bytes.toString(CryptoJS.enc.Utf8);
        const [keyNumber,nonce] = decryptedString.split(':'); // Assuming the nonce doesn't contain ':'
        return keyNumber;
    }

    resetOrSetKeys(userData)
    {
        userData.otherKeys=[];
        userData.keysPresentedDiff=0;
        userData=this.setNewKey(userData);
    }

    setNewKey(userData)
    {
        userData.key=this.random(1,191);        
        return (userData);
    }

    async StartGame(sessionId,userData,config)
    {
        userData.state= 'started';
        this.resetOrSetKeys(userData);
        config=this.sanitizeConfig(config,userData);        
        if (this.debug) console.log('Config',config);        
        userData= await this.processActionList(sessionId,config.onstart,userData,config);
        await this.storeUserData(sessionId,userData);
        if (this.debug) console.log('User data stored',userData);
        return (userData);
    }

    async tryStartGame(sessionId,config=null)
    {
        if (this.debug) console.log('Trying to start game for session ' + sessionId);
        let userData=await this.getUserData(sessionId);
        if (this.debug) console.log('Got user data for session ' + sessionId,userData);    
        if (userData.state == undefined) userData=await this.StartGame(sessionId,userData,config);
        
    }

    async processBasicInfo(session,bi)
    {
        let userData=await this.getUserData(session.session.sessionId);        
        if (session.role=="keyholder") 
        {
            if (this.debug) console.log('Adding correct key for session',session.session.sessionId);
            bi.key=this.encodeKeyNumber(userData.key);
            if (this.debug) console.log('Modified basicInfo',bi);
        }
        bi.gamestate=userData.state;
        bi.keyspresented=Math.max(1,bi.config.keyspresented+userData.keysPresentedDiff);
        return (bi);
    }

    async getKeyCandidates(req,res)
    {
        let response='';
        try
        {
            if (this.debug) console.log('GetKeyCandidates',req.body.mainToken);
            const session = await this.getSessionForMainToken(req.body.mainToken);
            //console.log('Sessions',session);
            //let userData=await this.getUserData(session.session.sessionId);
            let userData=session.session.data;
            let config=this.sanitizeConfig(session.session.config,userData);
            if (userData.state == undefined) userData=await this.tryStartGame(session.session.sessionId,userData,config);
            let keys=[];
            const actions=await this.getRegularActions(session.session.sessionId);
             if ((actions.nbActionsRemaining >0) || ((actions.nbActionsRemaining==-1)))
             {
                
                keys.push(userData.key);
                userData=await this.ensureOtherKeys(session.session.sessionId,userData,config.keyspresented);
                let i=0;
                while (keys.length<config.keyspresented) keys.push(userData.otherKeys[i++]); 
                keys=this.shuffleInPlace(keys);
                
             }
             if (this.debug) console.log('GetKeyCandidates-after',session.session.sessionId,'Modified config keyspresented:',config.keyspresented,'keys.length:',keys.length,'otherkeys.length:',userData.otherKeys.length);

        if (response==null) return res.status(200).send(JSON.stringify({}));
        return res.status(200).send(JSON.stringify({"keys":keys.map(k=>this.encodeKeyNumber(k))})); 
        }
        catch (err)
        {
            console.log(err);
            return res.status(501).send('Internal server error');
        }

    }

    async guessKey(req,res)
    {
        let response='';
        try
        {
            if (this.debug) console.log('GuessKey',req.body.mainToken,req.body.guessKeyId);
            const session = await this.getSessionForMainToken(req.body.mainToken);
            let userData=session.session.data;            
            let config=this.sanitizeConfig(session.session.config,userData);
            //let userData=await this.getUserData(session.session.sessionId);
            if (userData.state == undefined) userData=await this.tryStartGame(session.session.sessionId,userData,config);
            const guessedKey=this.decodeKeyNumber(req.body.guessKeyId);
            const guessOk=(guessedKey==userData.key);
            if (this.debug) console.log('Wearer guess is '+((guessOk)?'correct':'incorrect'));
            const response={guessResult:null}
            const actions=await this.getRegularActions(session.session.sessionId);
             if ((actions.nbActionsRemaining >0) || ((actions.nbActionsRemaining==-1)))
             {
                const a=await this.submitRegularAction(session.session.sessionId,{'message':'Wearer guessed '+((guessOk)?'correct':'wrong')+' key'});
                response.guessResult=guessOk;
                if (guessOk) 
                {
                    this.stats.statsCounterInc('keys_guessed','{result="correct"}');
                    await this.processActionList(session.session.sessionId,config.oncorrect,userData,config,guessedKey);
                    userData.state= 'finished';
                    await this.storeUserData(session.session.sessionId,userData);
                    await this.customLogMessage(session.session.sessionId,'user','Guessed the correct key','The correct key has been guessed by the wearer.');
                }
                else 
                {
                    this.stats.statsCounterInc('keys_guessed','{result="incorrect"}');
                    await this.processActionList(session.session.sessionId,config.onwrong,userData,config,guessedKey);
                    await this.customLogMessage(session.session.sessionId,'user','Guessed the wrong key','Wearer guessed incorrectly.');
                }
             }


        if (response==null) return res.status(200).send(JSON.stringify({}));
        return res.status(200).send(JSON.stringify({"guess":response.guessResult})); 
        }
        catch (err)
        {
            console.log(err);
            return res.status(501).send('Internal server error');
        }

    }  
    
    async processActionList(sessionId,actions,userData,config,guessedKey)
    {
        if (this.debug) console.log('Processing action list',actions)
        for (var i=0; i<actions.length; i++)
    //    actions.forEach(async action =>
            {
                const action=actions[i];
                if (this.debug) console.log('Action',action);
                switch (action.action) 
                {
                    case 'freeze': await this.freeze(sessionId);
                        break;
                    case 'unfreeze': await this.unfreeze(sessionId);
                        break;                        
                    case 'block': await this.setReasonsPreventingUnlocking(sessionId,'Must find a key');
                        break;                                                
                    case 'unblock': await this.setReasonsPreventingUnlocking(sessionId,'');
                        break;  
                    case 'addtime': await this.addTime(sessionId,action.time);
                        break;
                    case 'removetime': await this.removeTime(sessionId,action.time);
                        break;
                    case 'resetkeys': 
                        {
                            if (this.chance(action.number))
                            {
                                this.resetOrSetKeys(userData); 
                                this.stats.statsCounterInc('keys_reset','{reason="wrongguess"}');
                            }
                            await this.storeUserData(sessionId,userData);
                            
                        }
                        break; 
                    case 'removeguessedkey':
                    case 'replaceguessedkey':
                            if (this.debugNew) console.log(sessionId,'Removing ('+action.action+') guessed key',guessedKey);
                            const preCount=userData.otherKeys.length;
                            if (this.debugNew) console.log(sessionId,'Otherkeys pre removal',userData.otherKeys,'count:',preCount);
                            userData.otherKeys=userData.otherKeys.filter(k=>k!=guessedKey);
                            const postCount=userData.otherKeys.length;
                            if (this.debugNew) console.log(sessionId,'Otherkeys post removal',userData.otherKeys,'post count:',postCount,'Diff:',postCount-preCount);
                            userData.otherKeys=this.shuffleInPlace(userData.otherKeys);
                            if ((action.action=='removeguessedkey') && (postCount!=preCount)) await this.setKeysPresentedDiffInc(sessionId,userData,config,postCount-preCount,false);
                            if (this.debug) console.log('afterremovedkey',sessionId,'NewDiff:',userData.keysPresentedDiff);
                            await this.storeUserData(sessionId,userData);
                        break;
                    case 'removefakekeys':
                            await this.setKeysPresentedDiffInc(sessionId,userData,config,-1*action.number,true);
                        break;
                    case 'addfakekeys':
                            await this.setKeysPresentedDiffInc(sessionId,userData,config,action.number,true);
                        break;
                    case 'change': 
                        {
                            userData.otherKeys=this.shuffleInPlace(userData.otherKeys);
                            for (let i=0;i<action.number;i++) userData.otherKeys.shift();
                            await this.storeUserData(sessionId,userData);
                        }
                        break;                          
                    case 'changekey': 
                        {
                            if (this.chance(action.number))
                            {
                                userData=this.setNewKey(userData);
                                this.stats.statsCounterInc('keys_changed','{reason="wrongguess"}');
                            }
                            await this.storeUserData(sessionId,userData);
                        }
                        break;                                                  
                }
        } //);
        return (userData);
    }

    actionTextSummary(action)
    {
        let result='action.action';

        switch (action.action) 
        {
            case 'freeze': result='Freeze the lock'; break;
            case 'unfreeze': result='Unfreeze the lock'; break;
            case 'block': result='Block unlocking'; break;
            case 'unblock': result='Allow unlocking'; break;
            case 'addtime': result='Add '+this.formatTimeString(action.time); break;
            case 'removetime': result='Remove '+this.formatTimeString(action.time); break;
            case 'resetkeys':  result='1 in '+action.number+' chance to reset all keys'; break;
            case 'removeguessedkey': result='Remove guessed key'; break;
            case 'replaceguessedkey': result='Replace guessed key'; break;
            case 'change': result='Change '+action.number+' fake key'+((action.number!=1)?'s':''); break;
            case 'changekey':  result='1 in '+action.number+' chance to change correct key'; break;
        }
        return(result);

    }

    onBeforeConfigSave(config)
    {
        config.config.textConfig='';
        /*
        console.log('preconfig',config);
        config.config.textConfig=config.config.keyspresented+" keys presented\r\n\r\n";
        let actions=[];
        config.config.onstart.forEach(a=>actions.push('- '+this.actionTextSummary(a)+"\r\n"));
        config.config.textConfig+='On start: \r\n\r\n'+actions.join('')+"\r\n\r\n";
        actions=[];
        config.config.onwrong.forEach(a=>actions.push('- '+this.actionTextSummary(a)+"\r\n"));
        config.config.textConfig+='On wrong guess: \r\n\r\n'+actions.join('')+"\r\n\r\n";
        actions=[];
        config.config.oncorrect.forEach(a=>actions.push('- '+this.actionTextSummary(a)+"\r\n"));
        config.config.textConfig+='On correct guess: \r\n\r\n'+actions.join('')+"\r\n";
        */
        return(config);
    }
    
    
    async restartGame(req,res)
    {
        let response='';
        try
        {
            if (this.debug) console.log('RestartGame',req.body.mainToken);
            const session = await this.getSessionForMainToken(req.body.mainToken);
            let userData=session.session.data;
            //let userData=await this.getUserData(session.session.sessionId);
            if (this.debug) console.log('Game state',userData.state,'User role',session.role,'Trust state',session?.session?.lock?.trusted);
            if ((userData.state == 'finished') || (session.role=="keyholder") )
            //NEW FEATUREif ( ((userData.state == 'finished') && (session.role=="wearer")) || ( (session.role=="keyholder") && (session?.session?.lock?.trusted===true) )  )
            {
                userData=await this.StartGame(session.session.sessionId,userData,session.session.config);
            }

            return res.status(200).send(JSON.stringify({})); 
        }
        catch (err)
        {
            console.log(err);
            return res.status(501).send('Internal server error');
        }   
    }

    async changeKey(req,res)
    {
        let response='';
        try
        {
            let result={};
            if (this.debug) console.log('changeKey',req.body.mainToken);
            const session = await this.getSessionForMainToken(req.body.mainToken);
            let userData=session.session.data;
            //let userData=await this.getUserData(session.session.sessionId);
            if (this.debug) console.log('Game state',userData.state,'User role',session.role,'Trust state',session?.session?.lock?.trusted);
            const silent=req.body.silent;
            if (session.role=="keyholder")
            {
                userData=this.setNewKey(userData);
                await this.storeUserData(session.session.sessionId,userData);
                if (session.role=="keyholder") 
                {
                    result.newKey=this.encodeKeyNumber(userData.key);
                }

                if (silent === true)
                {
                    this.stats.statsCounterInc('keys_changed','{reason="keyholder",message="silent"}');
                }
                else
                {
                    await this.customLogMessage(session.session.sessionId,session.role,'Changed the correct key','The correct key has been changed.');
                    this.stats.statsCounterInc('keys_changed','{reason="keyholder",message="logged"}');
                }
            }

            return res.status(200).send(JSON.stringify(result)); 
        }
        catch (err)
        {
            console.log(err);
            return res.status(501).send('Internal server error');
        }   
    }

    async addFakeKeys(req,res)
    {
        let response='';
        try
        {
            let result={};
            if (this.debug) console.log('addFakeKeys',req.body.mainToken);
            const session = await this.getSessionForMainToken(req.body.mainToken);
            let userData=session.session.data;            
            let config=this.sanitizeConfig(session.session.config,userData);
            //let userData=await this.getUserData(session.session.sessionId);
            let addCount=req.body.count;
            if (this.debug) console.log('Game state',userData.state,'User role',session.role);
            if ((session.role=="keyholder") || ( ((session.role=="wearer") && addCount>0)  ))
            {
                if (addCount>100) addCount=100;
                if (addCount<-100) addCount=-100;
                await this.setKeysPresentedDiffInc(session.session.sessionId,userData,config,addCount,true);

                if (session.role=="keyholder")
                {
                    if (req.body.silent === true)
                    {
                        if (addCount>0) this.stats.statsCounterInc('fake_keys_added','{reason="keyholder",message="silent"}',addCount);
                        if (addCount<0) this.stats.statsCounterInc('fake_keys_removed','{reason="keyholder",message="silent"}',-1-addCount);
                    }
                    else
                    {
                        if (addCount>0) await this.customLogMessage(session.session.sessionId,session.role,'Added fake keys','Added '+addCount+' fake key'+((addCount>1)?'s':'')+'.');
                        if (addCount<0) await this.customLogMessage(session.session.sessionId,session.role,'Removed fake keys','Removed '+(-1*addCount)+' fake key'+((addCount<-1)?'s':'')+'.');                        
                        if (addCount>0) this.stats.statsCounterInc('fake_keys_added','{reason="keyholder",message="logged"}',addCount);
                        if (addCount<0) this.stats.statsCounterInc('fake_keys_removed','{reason="keyholder",message="logged"}',-1-addCount);
                    }
                }



            }

            return res.status(200).send(JSON.stringify(result)); 
        }
        catch (err)
        {
            console.log(err);
            return res.status(501).send('Internal server error');
        }   
    }
    

    async ensureOtherKeys(sessionId,userData,count)
    {
        let changed=false;
        count=Math.min(count,100);
        if (userData.otherKeys == undefined) userData.otherKeys=[];
        while (userData.otherKeys.length<count)
        {
            changed=true;
            let newKey=userData.key;
            while ((newKey == userData.key) || ( userData.otherKeys.includes(newKey))) newKey=this.random(1,191);
            userData.otherKeys.push(newKey);
        }

        if (changed) await this.storeUserData(sessionId,userData);
        return(userData);
    }

    parseActionLogEvents(data)
    {
        let events=[];
        if ((data?.data?.actionLog?.role == 'user') &&  (data?.data?.actionLog?.extension == 'wheel-of-fortune') && (data?.data?.actionLog?.type== 'wheel_of_fortune_turned'))
        {
         let event={event:'wheel_of_fortune_turned',detail:data?.data?.actionLog?.payload?.segment?.text, sessionId:data?.data?.sessionId };
         events.push(event);
         
        }
        if ( (data?.data?.actionLog?.extension == 'tasks') && (data?.data?.actionLog?.type== 'tasks_task_completed'))
        {
         let event={event:'tasks_task_completed',detail:data?.data?.actionLog?.payload?.task?.task, sessionId:data?.data?.sessionId };
         events.push(event);
        }
        if ( (data?.data?.actionLog?.extension == 'tasks') && (data?.data?.actionLog?.type== 'tasks_task_failed'))
        {
         let event={event:'tasks_task_failed',detail:data?.data?.actionLog?.payload?.task?.task, sessionId:data?.data?.sessionId };
         events.push(event);
        }  
        return events;
    }

    async processActionLogEvent(e)
    {
        let session=await this.getSession(e.sessionId);
        //console.log(session);
        let config=session.session.config;
        let userData=session.session.data;
        config=this.sanitizeConfig(config, userData);
        //console.log('config',config,'userData',userData);
        if (config.oncustom != undefined)
        {
            config.oncustom.forEach(async oncustom=>
                {
                    if ((oncustom.event==e.event) && (oncustom.detail=='' || oncustom.detail==undefined || oncustom.detail=='undefined' || (oncustom.detail.toUpperCase()==e.detail.toUpperCase())))
                    {
                        //console.log('Action match',oncustom);
                        await this.processActionList(e.sessionId,oncustom.actions,userData,config);
                    }
                });
        }
        //async processActionList(sessionId,actions,userData,guessedKey)
    }

    async processActionLog(data)
    {
       try
       { 
        //console.log('Processing action log',data.data);
        const events=this.parseActionLogEvents(data);
        if (this.debugWebHooks) console.log('Processing actionlog events:',events);
        events.forEach(async e=> await this.processActionLogEvent(e));
       }
       catch (error)
       {
        console.log('Error processing action log',error);
       }
    }

    async setKeysPresentedDiffInc(sessionId, userData, config,inc,save=true)
    {
      if (userData.keysPresentedDiff==undefined) userData.keysPresentedDiff=0;
      const logpre=userData.keysPresentedDiff;
      userData.keysPresentedDiff+=inc;
      userData.keysPresentedDiff=Math.min(userData.keysPresentedDiff,100-config.keyspresentedOrig);  
      userData.keysPresentedDiff=Math.max(userData.keysPresentedDiff,-1*config.keyspresentedOrig+1);  
      if (this.debug) console.log('Modifying KeyPresentedDiff',sessionId,'pre:',logpre,'post:',userData.keysPresentedDiff,'config:',config.keyspresented,'configOrig:',config.keyspresentedOrig,'inc:',inc);

      if (save) await this.storeUserData(sessionId,userData);
      return (config);  
    }

    async generateMetrics(metrics)
    {
        if (this.debug) console.log('Generating metrics for Find The Key');
        metrics=await super.generateMetrics(metrics);
        //console.log(sessions.results[0].lock.user.username);
        if (this.globalMetrics.locked_sessions != undefined) 
        {
            metrics += "#HELP locked_sessions Current number of active sessions\n#TYPE locked_sessions gauge\n";
            metrics += "locked_sessions "+this.globalMetrics.locked_sessions+"\n";
        }
        if (this.globalMetrics.testlocks != undefined) 
        {
            metrics += "#HELP test_locks Current number of test locks\n#TYPE test_locks gauge\n";
            metrics += "test_locks "+this.globalMetrics.testlocks+"\n";
        }
        if (this.globalMetrics.keyholdedlocks != undefined) 
        {
            metrics += "#HELP keyholded_locks Current number of locks with keyholder\n#TYPE keyholded_locks gauge\n";
            metrics += "keyholded_locks "+this.globalMetrics.keyholdedlocks+"\n";
        }
        if (this.globalMetrics.keyholdedlocks_trusted != undefined) 
        {
            metrics += "#HELP keyholded_locks_trusted Current number of locks with keyholder trusted\n#TYPE keyholded_locks_trusted gauge\n";
            metrics += "keyholded_locks_trusted "+this.globalMetrics.keyholdedlocks_trusted+"\n";
        }
        if (this.globalMetrics.wearers != undefined) 
        {
            metrics += "#HELP wearers Current number of unique wearers\n#TYPE wearers gauge\n";
            metrics += "wearers "+this.globalMetrics.wearers+"\n";
        }        
        if (this.globalMetrics.keyholders != undefined) 
        {
            metrics += "#HELP keyholders Current number of unique key holders\n#TYPE keyholders gauge\n";
            metrics += "keyholders "+this.globalMetrics.keyholders+"\n";
        }                
        if (this.debug) console.log('Generated metrics',metrics);
        return (metrics);
    }

    async prepareGlobalMetrics(cnt=0)
    {
        try
        {
            //const sessions = await  this.findAllSessions(this.slug);
            let sessions=undefined;
            if (cnt%5==0)
               sessions = await  this.findAllSessions(this.slug);
            else
               sessions = await  this.searchSessions(this.slug);
            if ((sessions != undefined) && (sessions.count != undefined))
            {
                this.globalMetrics.locked_sessions = sessions.count;
            }

            if ((sessions.results != undefined) && (sessions.hasMore==false)) //parse only on complete results
            {
                let wearers={};
                let keyholders={};
                let testlocks=0;
                let keyholdedlocks=0;
                let keyholdedlocks_trusted=0;
                sessions.results.forEach((s) => 
                {
                    if (s?.lock?.user?.username != undefined) wearers[s.lock.user.username]=s.lock.user.username;
                    if (s?.lock?.keyholder?.username != undefined) 
                    {
                        keyholders[s.lock.keyholder.username]=s.lock.keyholder.username;
                        keyholdedlocks++;
                        if (s?.lock?.trusted) keyholdedlocks_trusted++;
                    }
                    if (s?.lock?.isTestLock == "true") testlocks += 1;
                });
                this.globalMetrics.testlocks=testlocks;
                this.globalMetrics.keyholdedlocks=keyholdedlocks;
                this.globalMetrics.keyholdedlocks_trusted=keyholdedlocks_trusted;
                this.globalMetrics.keyholders=Object.keys(keyholders).length;
                this.globalMetrics.wearers=Object.keys(wearers).length;
            }
            if (this.debug) console.log('Global metrics',this.globalMetrics);
        }
        catch (err)
        {
            if (this.debug)  console.log('Error during prepareGlobalMetrics',err);
        }
        setTimeout(async ()=>{await this.prepareGlobalMetrics(cnt+1);},60000);
    }
    


    
}

export {FindTheKey}