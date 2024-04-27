import {Extension} from './extension.js';
import path from 'path';

import CryptoJS from 'crypto-js';

import {StatsSpooler,StatsCounter} from './StatsSpooler.js';

import crypto from 'crypto';


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

        this.initUnfairSettings();
        

        this.webhooks['extension_session.created']= async (data,req,res) =>  
        {
            if (this.debugWebHooks) console.log('New session reported by webhook',data.data.session.sessionId);
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
      if (!(config.sanitized))
      {
        config.sanitized = true;
        config.keyspresentedOrig=config.keyspresented; 
        if (userData?.keysPresentedDiff != 0) config.keyspresented += userData?.keysPresentedDiff;
        config.keyspresented=Math.min(config.keyspresented,100);  
        config.keyspresented=Math.max(config.keyspresented,1); 
      }
      return (config);  
    }

    setupStats()
    {
        super.setupStats();
        this.stats.addStat(new StatsCounter('keys_displayed','The total number of keys displayed to the users'));
        this.stats.addStat(new StatsCounter('keys_guessed','The total number of keys guessed by the wearers'));
        this.stats.addStat(new StatsCounter('keys_reset','The total number of key resets midgame'));
        this.stats.addStat(new StatsCounter('keys_changed','The total number of correct keys changed midgame'));
        this.stats.addStat(new StatsCounter('fake_keys_added','The total number of fake keys added midgame'));
        this.stats.addStat(new StatsCounter('fake_keys_removed','The total number of fake keys removed midgame'));        
        this.stats.addStat(new StatsCounter('fake_keys_add_action','The total number of add fake keys actions'));
        this.stats.addStat(new StatsCounter('fake_keys_remove_action','The total number of remove fake keys actions'));                
        this.stats.addStat(new StatsCounter('game_restart','The total number of game restarts'));                
        this.stats.addStat(new StatsCounter('pillory','The total number of wearers sent to the pillory'));
        this.stats.addStat(new StatsCounter('unfair_events_generate','Unfair events generation counters'));
        
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
        app.post('/'+prefix+'api/setblockers',  async (req, res) => { await this.setBlockers(req, res); });
        app.post('/'+prefix+'api/setunfairs',  async (req, res) => { await this.setUnfairs(req, res); });
        app.post('/'+prefix+'api/setunfairsettings',  async (req, res) => { await this.setunfairsettings(req, res); });
        app.post('/'+prefix+'api/addfakekeys',  async (req, res) => { await this.addFakeKeys(req, res); });        
        app.post('/'+prefix+'api/unblock',  async (req, res) => { await this.unblock(req, res); });
    }

    async processDelayedEvent(delayedEvent)
    {
        await super.processDelayedEvent(delayedEvent);
        switch (delayedEvent.type) 
        {
            case 'actions':
            {
                if (delayedEvent?.sessionId != undefined)
                {
                    if (this.debug) console.log(delayedEvent.sessionId,'processing Delayed Event - actions',delayedEvent.actions);
                    let release = await this.ensureCS(delayedEvent.sessionId);
                    try
                    {
                        let session=await this.getSession(delayedEvent.sessionId);
                        //console.log(session);
                        let userData= session.session.data;
                        let config= session.session.config;
                        config=this.sanitizeConfig(config,userData);        
                        userData= await this.processActionList(delayedEvent.sessionId,delayedEvent.actions,userData,config,delayedEvent.guessedKey);
                        await this.storeUserData(delayedEvent.sessionId,userData);
                    }
                    catch (error)
                    {
                        console.log('delayed event error',error);
                    }
                    if (release != null) release();
                }
            }
            break;
        }

    }

    sendKey(req, res)
    {
        const keyId = req.params.keyId;
        const decodedKeySpec = this.decodeKeySpec(keyId);
        if (decodedKeySpec.key>0) 
        {
            this.stats.statsCounterInc('keys_displayed','');
            res.sendFile(path.join(process.cwd(), 'public', 'keys' ,  ((decodedKeySpec.obfuscated)?'obf_':'')+((decodedKeySpec.twin)?'twin_':'')+'key'+decodedKeySpec.key+'.png'));
        }
        else
        {
            return res.status(403).send('');
        }
    }


    encodeKeySpec(keySpec) 
    {
        const nonce = Date.now().toString(); // Using a timestamp as a nonce
        const flags = ''+((keySpec.obfuscated)?'O':'')+((keySpec.twin)?'T':'');
        const combinedString = `${keySpec.key}:${flags}:${nonce}`;
        const encryptedData = CryptoJS.AES.encrypt(combinedString, this.key_key).toString();
        const base64 = Buffer.from(encryptedData).toString('base64');
        return base64;
    }
      
    decodeKeySpec(base64String) 
    {
        const encryptedString = Buffer.from(base64String, 'base64').toString('utf8');
        const bytes = CryptoJS.AES.decrypt(encryptedString, this.key_key);
        const decryptedString = bytes.toString(CryptoJS.enc.Utf8);
        const [keyNumber,flags,nonce] = decryptedString.split(':'); // Assuming the nonce doesn't contain ':'
        return ({key:keyNumber,obfuscated:flags.includes('O'),twin:flags.includes('T')});
    }

    resetOrSetKeys(userData,resetFakeCount=true)
    {
        userData.knownableWrongs={};
        userData.otherKeys=[];
        if (resetFakeCount) userData.keysPresentedDiff=0;
        userData=this.setNewKey(userData);
    }

    setNewKey(userData)
    {
        userData.knownableWrongs={};        
        userData.key=this.random(1,191);        
        return (userData);
    }

    async burnTries(sessionId,userData,actionData,triesToBurn=null)
    {
        console.log(sessionId,'Action data for burnTries',actionData);
        if (triesToBurn==null) triesToBurn=actionData.actionsRemaining-1;
        if ((actionData!=undefined) && (actionData.mode=='cumulative') && (triesToBurn>0))
        {
            if (this.debug) console.log(sessionId,'Burning ',triesToBurn,'actions');
            if (userData.cumulativeBurned==undefined) userData.cumulativeBurned=0;
            userData.cumulativeBurned+=triesToBurn;
            await this.storeUserData(sessionId,userData);
        }
    }

    async StartGame(sessionId,userData,config)
    {
        userData.state= 'started';
        userData.keysguessed=0;
        userData.keysguessedwrong=0;
        userData.lastGuessed=null;
        userData.knownableWrongs={};
        userData.unfairs=[];
        userData.blocks=[];
        this.resetOrSetKeys(userData);
        config=this.sanitizeConfig(config,userData);        
        if (this.debug) console.log(sessionId,'StartGame','Config',config);        
        userData= await this.processActionList(sessionId,config.onstart,userData,config);
        this.generateUnfairsAndBlocks(sessionId,userData,config,0);
        await this.storeUserData(sessionId,userData);
        if (this.debug) console.log(sessionId,'User data stored',userData);        
        return (userData);
    }

    async tryStartGame(sessionId,config=null)
    {
        if (this.debug) console.log(sessionId,'Trying to start game for session ' + sessionId);
        let userData=await this.getUserData(sessionId);
        if (this.debug) console.log('Got user data for session ' + sessionId,userData);    
        if (userData.state == undefined) userData=await this.StartGame(sessionId,userData,config);
       
    }

    initUnfairSettings()
    {
        this.unfairSettings=
        {
            unabletoguess :              [0,10,15,20,33,50],
            delayactions  :              [0, 0, 0,15,33,50],
            hidekeys :                   [0, 0,10,15,33,50],
            doubleactions :              [0, 0,10,15,33,50],
            twins :                      [0, 0,10,15,33,50],
            nocorrectkey :               [0, 0, 0,15,33,50],
            liecorrect:                  [0, 0, 0, 7,15,20],
            blocktime:                   [0, 5, 5,10,15,25],
            blocktime_time:              [5*60, 5*60, 5*60, 5*60,15*60,60*60],
            delayactions_time :          [0, 10*60, 20*60, 30*60,60*60,90*60],
            blockverification :          [0, 0, 0,5,10,15],
            blockjigsaw_complete :       [0, 0, 0,5,10,15],
            blockshared_link :           [0,5,9,15,20,33],
            blockturn_wheel_of_fortune:  [0,5,7,10,13,20],
            blocktask_completed:         [0,5,5,7,10,20],
            blocktask_failed:            [0,0,0,5,5,10],
            
        };
    }

    getUnfairSetting(sessionId,userData,config,guessNumber,session,nodefaults=false)
    {
        let result = {};
        Object.keys(this.unfairSettings).forEach( (k) => result[k]=null);

        if ((this.isTrue(config?.unfairsenabled)) && (config?.unfairslevel != undefined) && (nodefaults==false))
        {
            Object.keys(this.unfairSettings).forEach( (k) =>  { if (this.unfairSettings[k][config.unfairslevel] != undefined) result[k] = this.unfairSettings[k][config.unfairslevel];});
        }

        if (userData?.unfairsetting!=undefined)
        {
            Object.keys(this.unfairSettings).forEach( (k) =>  { if (userData.unfairsetting[k] != undefined) result[k] = userData.unfairsetting[k];});
        }

        if (this.config) console.log(sessionId,"Calculated Unfair Settings:",result);
        return (result);
    }



    generateUnfairsAndBlocks(sessionId,userData,config,guessNumber,session=null)
    {
        if (userData.unfairs == undefined) userData.unfairs=[];
        if (userData.blocks == undefined) userData.blocks=[];
        if (this.isTrue(config?.unfairsenabled))
        {
            if (this.debug) console.log(sessionId,'Generating unfairs and blocks for guess',guessNumber);
            this.stats.statsCounterInc('unfair_events_generate','{event="generation_rounds",unfairslevel="'+(config.unfairslevel)+'"}');
            const chances= this.getUnfairSetting(sessionId,userData,config,guessNumber,session);

            let extensions=[];
            //console.log('extensons',session?.lock?.extensions);
            if ((session != null) && (session?.lock?.extensions != undefined)) session.lock.extensions.forEach ( (e) => extensions.push(e.slug));
            if (this.debug) console.log (sessionId,'Lock extensions detected: ',extensions);

            if (this.chancePct(chances['unabletoguess'])) { userData.unfairs.push({guess:guessNumber,stage:'beforeguess',type:'unabletoguess',level:1}); this.stats.statsCounterInc('unfair_events_generate','{event="generated_unabletoguess",unfairslevel="'+(config.unfairslevel)+'"}'); }

            if (this.chancePct(chances['hidekeys'])) { userData.unfairs.push({guess:guessNumber,stage:'displaycandidates',type:'hidekeys',level:2}); this.stats.statsCounterInc('unfair_events_generate','{event="generated_hidekeys",unfairslevel="'+(config.unfairslevel)+'"}'); } 
            if (this.chancePct(chances['doubleactions'])) { userData.unfairs.push({guess:guessNumber,stage:'wrongguess',type:'doubleactions',level:2}); this.stats.statsCounterInc('unfair_events_generate','{event="generated_doubleactions",unfairslevel="'+(config.unfairslevel)+'"}'); } 
            if (this.chancePct(chances['twins'])) { userData.unfairs.push({guess:guessNumber,stage:'displaycandidates',type:'twins',level:2}); this.stats.statsCounterInc('unfair_events_generate','{event="generated_twins",unfairslevel="'+(config.unfairslevel)+'"}'); }
            if (this.chancePct(chances['nocorrectkey'])) { userData.unfairs.push({guess:guessNumber,stage:'displaycandidates',type:'nocorrectkey',level:3}); this.stats.statsCounterInc('unfair_events_generate','{event="generated_nocorrectkey",unfairslevel="'+(config.unfairslevel)+'"}'); }
            if (this.chancePct(chances['liecorrect'])) { userData.unfairs.push({guess:guessNumber,stage:'beforeguess',type:'liecorrect',level:4}); this.stats.statsCounterInc('unfair_events_generate','{event="generated_liecorrect",unfairslevel="'+(config.unfairslevel)+'"}'); }            
            if (this.chancePct(chances['delayactions'])) {  userData.unfairs.push({guess:guessNumber,stage:'correctguess',type:'delayactions',level:3,time:this.random(chances['delayactions_time']*0.5,chances['delayactions_time']*1.5)}); this.stats.statsCounterInc('unfair_events_generate','{event="generated_delayactions",unfairslevel="'+(config.unfairslevel)+'"}'); }            

            if ((extensions.includes('verification-picture')) && (this.chancePct(chances['blockverification']))) { userData.blocks.push({type:'verification'});this.stats.statsCounterInc('unfair_events_generate','{event="generated_verification",unfairslevel="'+(config.unfairslevel)+'"}'); }            
            if ((extensions.includes('link')) && (this.chancePct(chances['blockshared_link']))) { userData.blocks.push({type:'shared_link'});this.stats.statsCounterInc('unfair_events_generate','{event="generated_shared_link",unfairslevel="'+(config.unfairslevel)+'"}'); }                        
            if ((extensions.includes('wheel-of-fortune')) && (this.chancePct(chances['blockturn_wheel_of_fortune']))) { userData.blocks.push({type:'turn_wheel_of_fortune'});this.stats.statsCounterInc('unfair_events_generate','{event="generated_turn_wheel_of_fortune",unfairslevel="'+(config.unfairslevel)+'"}'); }                                    
            if ((extensions.includes('tasks')) && (this.chancePct(chances['blocktask_completed']))) { userData.blocks.push({type:'task_completed'});this.stats.statsCounterInc('unfair_events_generate','{event="generated_task_completed",unfairslevel="'+(config.unfairslevel)+'"}'); }                                                
            else if ((extensions.includes('tasks')) && (this.chancePct(chances['blocktask_failed']))) { userData.blocks.push({type:'task_failed'});this.stats.statsCounterInc('unfair_events_generate','{event="generated_task_failed",unfairslevel="'+(config.unfairslevel)+'"}'); }                                                            
            if ((extensions.includes('jigsaw-puzzle')) && (this.chancePct(chances['blockjigsaw_complete']))) { userData.blocks.push({type:'jigsaw_complete'});this.stats.statsCounterInc('unfair_events_generate','{event="generated_jigsaw_complete",unfairslevel="'+(config.unfairslevel)+'"}'); }                                                
            if (this.chancePct(chances['blocktime'])) { userData.blocks.push({type:'add_time',time:this.random(chances['blocktime_time']*0.5,chances['blocktime_time']*1.5)}); this.stats.statsCounterInc('unfair_events_generate','{event="generated_addtime",unfairslevel="'+(config.unfairslevel)+'"}'); }            
            
            


            if (config?.unfairslevel>= 1) 
            {
                if (guessNumber==0) userData.unfairs.push({guess:guessNumber,stage:'beforeguess',type:'liecorrect',level:1});
            }

            if (config?.unfairslevel>= 2) 
            {
                if (guessNumber==1) userData.unfairs.push({guess:guessNumber,stage:'beforeguess',type:'liecorrect',level:2}); 
                
            }
            if (config?.unfairslevel>= 3) 
            {
                if (guessNumber==0) if (this.chancePct(chances['delayactions'])) userData.unfairs.push({guessmin:0,guessmax:99999,stage:'correctguess',type:'delayactions',level:3,time:this.random(chances['delayactions_time']*0.5,chances['delayactions_time']*1.5)});
            }

            //if (this.debug) console.log(sessionId,'Generated unfairs for guess. All unfairs:',userData.unfairs);
        }
        else
            if (this.debug) console.log(sessionId,'Unfairs disabled - no unfairs generated');
        return (userData);
    }

    async processUnfairs(sessionId,userData,config,guessNumber,result,details)
    {
        if (userData.unfairs == undefined) userData.unfairs=[];
        if (this.isTrue(config?.unfairsenabled))
        {
            const unfairs=userData.unfairs.filter (u =>  ( (u.guess==guessNumber) || (u.guessmin != undefined) && (u.guessmax != undefined) && (u.guessmin<=guessNumber) && (u.guessmax>=guessNumber)  ) && ( (u.level<=config?.unfairslevel) || (u.source=="keyholder")  ) );
            if (unfairs.length>0) 
            {
                if (this.debug) console.log(sessionId,'Processing unfairs for guess',guessNumber,'Unfair level',config?.unfairslevel,'Unfairs:',unfairs);
                for (var i=0; i<unfairs.length; i++)
                    {
                        const unfair=unfairs[i];
                        if (unfair.type=='hidekeys') result.push('hidekeys');
                        if (unfair.type=='twins') result.push('twins');
                        if (unfair.type=='nocorrectkey') result.push('nocorrectkey');
                        if (unfair.type=='unabletoguess') result.push('unabletoguess');
                        if (unfair.type=='liecorrect') result.push('liecorrect');
                        if (unfair.type=='doubleactions') result.push('doubleactions');
                        if (unfair.type=='delayactions') { result.push('delayactions'); details['delayactions']=unfair;}
                        
                    }
                    if (this.debug) console.log(sessionId,'Unfair result',result);    
            }
            else
            {
                if (this.debug) console.log(sessionId,'Processing unfairs for guess',guessNumber,'Unfair level',config?.unfairslevel,'Unfairs:',[]);
            }


        }
        return (userData);
    }


    generateSeed(sessionId, guessNumber) 
    {
        // Combine the string and number into one string
        const input = `${sessionId}_${guessNumber}`;
    
        // Create a SHA-256 hash of the input
        const hash = crypto.createHash('sha256').update(input).digest('hex');
    
        // Convert the first 8 characters of the hash into a decimal number
        const seed = parseInt(hash.substring(0, 8), 16);
    
        return seed;
    }

    async processBasicInfo(session)
    {
        //let userData=await this.getUserData(session.session.sessionId);
        let bi=await super.processBasicInfo(session);
        //console.log('medi bi',bi);
        let userData=session.session.data;
        let localConfig=this.sanitizeConfig(bi.config,userData);
        if (session.role=="keyholder") 
        {
            //if (this.debug) console.log(session.session.sessionId,'Adding correct key info',userData.key);
            bi.key=this.encodeKeySpec({key:userData.key,twin:false,obfuscated:false});
            bi.unfairs=userData?.unfairs;
            let wrongs=[];
            if (userData?.knownableWrongs != undefined) 
            {
                Object.keys(userData.knownableWrongs).forEach(k=>wrongs.push(this.encodeKeySpec({key:k,twin:false,obfuscated:false})));
            }
            bi.knownablewrongs=wrongs;
            bi.blockers=userData.blocks;
            bi.unfairSettings=
                {
                default: this.getUnfairSetting(session.session.sessionId,{},localConfig,userData.keysguessed,session,false),
                user: this.getUnfairSetting(session.session.sessionId,userData,localConfig,userData.keysguessed,session,true)
                };
            
        }
        bi.gamestate=userData.state;
        bi.keyspresented=localConfig.keyspresented;
        bi.seed = this.generateSeed(session.session.sessionId,userData.keysguessed);
        if (userData.keysguessed == undefined) userData.keysguessed=0;
        if (userData.keysguessedwrong == undefined) userData.keysguessedwrong=0;
        bi.keysguessedwrong=userData.keysguessedwrong;
        bi.keysguessed=userData.keysguessed;
        bi.blocks=this.sanitizeBlocksForWearer(userData.blocks);
        bi.keyHash=this.hashKeys(userData,localConfig);
        //if (this.debug) console.log(session.session.sessionId,'Modified basicInfo',bi);        
        return (bi);
    }

    hashKeys(userData,localConfig)
    {
        return(this.hash({gamestate:userData.state,key:userData.key,otherKeys:userData.otherKeys,keysPresentedDiff:userData.keysPresentedDiff,presented:localConfig.keyspresented,blocks:userData.blocks,keysguessed:userData.keysguessed}));
    }

    hashSession(session)
    {
        const superHash=super.hashSession(session);
        
        let userData=session.session.data;
        let localConfig=this.sanitizeConfig(session.session.config,userData);
        const keyHash=this.hashKeys(userData,localConfig);
        //console.log('Hash data child',{super:superHash,keyHash});
        return this.hash({super:superHash,keyHash})
    }


    async checkBlocks(sessionId,session,userData,config,blocks)
    {
        if (userData.blocks==undefined) userData.blocks = [];
        userData.blocks.forEach( (b) => 
        {
            console.log('Block',b);
            switch (b.type) {
                case 'freeze': console.log(session); if (session?.lock?.isFrozen)  blocks.push(b); break;
            
                default: blocks.push(b) ; break;
            }
        });
        if (this.debug) console.log (sessionId,'block for lock:',blocks);
        return (userData);
    }    

    sanitizeBlocksForWearer(blocks)
    {
        if (blocks==undefined) blocks = [];
        return blocks.map ( (b) =>
        {
            switch (b.type) 
            {
                case 'add_time': return ({type: 'add_time'}); break;
                default:  return (b);  break;
            }
        });
    }


    async getKeyCandidates(req,res)
    {
        let response='';
        let release=null;
        try
        {
            //if (this.debug) console.log('GetKeyCandidates',req.body.mainToken);
            let session = await this.getSessionForMainToken(req.body.mainToken);
            release = await this.ensureCS(session.session.sessionId, async () => { session=await this.reloadSession(session.session.sessionId,session); });
            //console.log('Sessions',session);
            //let userData=await this.getUserData(session.session.sessionId);
            let userData=session.session.data;
            let config=this.sanitizeConfig(session.session.config,userData);
            if (userData.state == undefined) userData=await this.tryStartGame(session.session.sessionId,userData,config);

            
            let keys=[];
            let blocks = [];
            //const actions=await this.getRegularActions(session.session.sessionId);
            const actionInfo=this.regularActionInfo(session.session);
            let unfairs=[];
            let unfairDetails={};
            if (actionInfo.available)
            {
                userData= await this.processUnfairs(session.session.sessionId,userData,config,userData.keysguessed,unfairs,unfairDetails);                            
                userData= await this.checkBlocks(session.session.sessionId,session.session,userData,config,blocks);
                if (blocks.length==0)
                {
                    if (!(unfairs.includes('nocorrectkey'))) keys.push({key:userData.key,obfuscated:false,twin:false}); //do not show correct key if nocorrectkey unfair is detected
                    userData=await this.ensureOtherKeys(session.session.sessionId,userData,config.keyspresented+1);
                    let i=0;
                    while (keys.length<config.keyspresented) keys.push({key:userData.otherKeys[i++],obfuscated:false,twin:false}); 
                    if (unfairs.includes('twins'))  keys.forEach(k=>keys.push({key:k.key,obfuscated:k.obfuscated,twin:true})); //add twins if twins unfair detected, TBD: add actual twin images
                    keys=this.shuffleInPlace(keys);
                }
                else
                {
                    //there were blocks
                }
            }
            if (this.debug) console.log(session.session.sessionId,'GetKeyCandidates-after','Modified config keyspresented:',config.keyspresented,'keys.length:',keys.length,'otherkeys.length:',userData.otherKeys.length);

            if (unfairs.includes('hidekeys')) keys = keys.map(k=>{k.obfuscated=true;return(k);}); //hide keys if hidekeys unfair detected, TBD: generate pixelated images
        
             
             

        if (release != null) release();
        if (response==null) return res.status(200).send(JSON.stringify({}));
        return res.status(200).send(JSON.stringify({"keys":keys.map(k=>this.encodeKeySpec(k)),"blocks":this.sanitizeBlocksForWearer(blocks)})); 
        }
        catch (err)
        {
            if (release != null) release();
            console.log(err);
            return res.status(501).send('Internal server error');
        }

    }

    async guessKey(req,res)
    {
        let response='';
        let release=null;
        try
        {
            if (this.debug) console.log('GuessKey',req.body.mainToken,req.body.guessKeyId);
            let session = await this.getSessionForMainToken(req.body.mainToken);
            release = await this.ensureCS(session.session.sessionId, async () => { session=await this.reloadSession(session.session.sessionId,session); });
            let userData=session.session.data;            
            let config=this.sanitizeConfig(session.session.config,userData);
            //let userData=await this.getUserData(session.session.sessionId);
            if (userData.state == undefined) userData=await this.tryStartGame(session.session.sessionId,userData,config);
            let unfairs = [];
            let unfairDetails = {};
            let blocks = [];
            if (userData.keysguessed ==undefined) userData.keysguessed=0;
            if (userData.keysguessedwrong ==undefined) userData.keysguessedwrong=0;            
            const guessedKeySpec=this.decodeKeySpec(req.body.guessKeyId);
            const guessedKey=guessedKeySpec.key;
            let guessOk=(guessedKey==userData.key);
            const guessNr=userData.keysguessed; 
            if (this.debug) console.log(session.session.sessionId,'Wearer guessed key ',guessedKey,'. Correct key is ',userData.key,'. User guess is '+((guessOk)?'correct':'incorrect'));
            const response={guessResult:null,guessProcessed:null};
            const actionInfo=this.regularActionInfo(session.session);
            if (actionInfo.available)
             {
                userData= await this.checkBlocks(session.session.sessionId,session.session,userData,config,blocks);
                if (blocks.length > 0)
                {
                    //blocks
                    response.guessProcessed=false;
                    response.blocks=this.sanitizeBlocksForWearer(blocks);


                }
                else
                {
                    const a=await this.submitRegularAction(session.session.sessionId,{'message':'Wearer guessed '+((guessOk)?'correct':'wrong')+' key'});
                    userData.lastGuessed=new Date();                
                    userData.keysguessed++;                

                    userData= await this.processUnfairs(session.session.sessionId,userData,config,guessNr,unfairs,unfairDetails);                            
                    if (unfairs.includes('unabletoguess'))
                    {
                        if (this.debug) console.log(session.session.sessionId,' unabletoguess unfair activated, ignoring guess');
                        response.guessProcessed=false;
                        //should increment the wrong guess counter????

                        userData=this.generateUnfairsAndBlocks(session.session.sessionId,userData,config,userData.keysguessed,session.session);

                        await this.storeUserData(session.session.sessionId,userData);
                    }
                    else
                    {

                        response.guessProcessed=true;

                        if ((unfairs.includes('liecorrect')) && (guessOk))  // liecorrect unfair
                        {
                            if ((userData.otherKeys.length>0) && (config.keyspresented>1))
                            {
                                if (this.debug) console.log(session.session.sessionId,' liecorrect unfair activated, wearer guessed correctly, swapping correct key');  
                                guessOk=false;                            
                                const oldcorrectkey=userData.key;
                                userData.key=userData.otherKeys[0];
                                userData.otherKeys[0]=oldcorrectkey;
                            }
                        }


                        response.guessResult=guessOk;
                        if (guessOk) 
                        {
                            this.stats.statsCounterInc('keys_guessed','{result="correct"}');
                            userData.state= 'finished';
                            if (unfairs.includes('delayactions'))
                            {
                                this.delayedEvents.push({type:'actions',time:(Date.now()+(1000*unfairDetails['delayactions'].time)),sessionId:session.session.sessionId,actions:config.oncorrect,guessedKey:guessedKey});
                            }
                            else
                            {
                                await this.processActionList(session.session.sessionId,config.oncorrect,userData,config,guessedKey);
                            }
                            await this.storeUserData(session.session.sessionId,userData);
                            await this.customLogMessage(session.session.sessionId,'user','Guessed the correct key','The correct key has been guessed by the wearer.');
                        }
                        else 
                        {
                            userData.keysguessedwrong++;
                            this.stats.statsCounterInc('keys_guessed','{result="incorrect"}');
                            
                            
                            if (userData.knownableWrongs==undefined) userData.knownableWrongs={};
                            if (userData.knownableWrongs[guessedKey]==undefined) userData.knownableWrongs[guessedKey]=0;
                            const repeatedWrongGuess = (userData.knownableWrongs[guessedKey]>0);
                            
                            if (!(unfairs.includes('hidekeys'))) userData.knownableWrongs[guessedKey]++;

                            let wrongActions=config.onwrong;
                            if (config.oncustom != undefined)
                            {
                                const every=config.oncustom.filter(cust=> (cust.event=='on_guess_every') && (userData.keysguessedwrong>0)  && (cust.detail>0) && ((userData.keysguessedwrong % cust.detail)==0) );
                                const exact=config.oncustom.filter(cust=> (cust.event=='on_guess_x') && (userData.keysguessedwrong>0)  && (cust.detail>0) && ((userData.keysguessedwrong == cust.detail)) );
                                console.log(session.session.sessionId,'wrongGuess advanced','every cnt:',every.length,'exact cnt:',exact.length,'keysguessedwrong',userData.keysguessedwrong);
                                if (exact.length>0) exact.forEach ( e=> wrongActions.push(... e.actions ));
                                else if (every.length>0) every.forEach ( e=> wrongActions.push(... e.actions ));
                            
                                if (repeatedWrongGuess)
                                {
                                    console.log(session.session.sessionId,'knowable wrong guess');
                                    const knowablewrong=config.oncustom.filter(cust=> (cust.event=='knowablewrong')  );
                                    if (knowablewrong.length>0) knowablewrong.forEach ( e=> wrongActions.push(... e.actions ));
                                }
                            }
                            if (unfairs.includes('doubleactions')) wrongActions=this.doubleActions(session.session.sessionId,wrongActions,true);
                            await this.processActionList(session.session.sessionId,wrongActions,userData,config,guessedKey);
                            await this.customLogMessage(session.session.sessionId,'user','Guessed the wrong key','Wearer guessed incorrectly.');
                            this.generateUnfairsAndBlocks(session.session.sessionId,userData,config,userData.keysguessed,session.session);
                            await this.storeUserData(session.session.sessionId,userData);
                        }
                    }
                 }
             }

        if (release != null) release();
        if (response==null) return res.status(200).send(JSON.stringify({}));
        return res.status(200).send(JSON.stringify({"guess":response.guessResult,"guessprocessed":response.guessProcessed})); 
        }
        catch (err)
        {
            if (release != null) release();
            console.log(err);
            return res.status(501).send('Internal server error');
        }

    }  

    doubleActions(sessionId,actions,badonly=false)
    {
        if (this.debug) console.log(sessionId,'Doubling action list',actions);
        actions = actions.map( (a) =>
            {
                switch (a.action) 
                {
                
                    case 'removefakekeys': if (! badonly) a.number *= 2;break;
                    case 'addfakekeys':    a.number *= 2;break;
                    case 'removetime':     if (! badonly) a.time *=2; break;
                    case 'addtime':
                    case 'pillory':        a.time *=2; break;
                    case 'removeguessedkey':        a.action='replaceguessedkey' ; break;
                }
                return a;
            });
        return (actions);
    }
    
    async processActionList(sessionId,actions,userData,config,guessedKey)
    {
        if (this.debug) console.log(sessionId,'Processing action list',actions)
        for (var i=0; i<actions.length; i++)
    //    actions.forEach(async action =>
            {
                const action=actions[i];
                if (this.debug) console.log(sessionId,'Action',action);
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
                                this.resetOrSetKeys(userData,false); 
                                this.stats.statsCounterInc('keys_reset','{reason="wrongguess"}');
                            }
                            await this.storeUserData(sessionId,userData);
                            
                        }
                        break; 
                    case 'removeguessedkey':
                    case 'replaceguessedkey':
                            if (this.debug) console.log(sessionId,'Removing ('+action.action+') guessed key',guessedKey);
                            const preCount=userData.otherKeys.length;
                            if (this.debug) console.log(sessionId,'Otherkeys pre removal',userData.otherKeys,'count:',preCount);
                            userData.otherKeys=userData.otherKeys.filter(k=>k!=guessedKey);
                            const postCount=userData.otherKeys.length;
                            if (this.debug) console.log(sessionId,'Otherkeys post removal',userData.otherKeys,'post count:',postCount,'Diff:',postCount-preCount);
                            userData.otherKeys=this.shuffleInPlace(userData.otherKeys);
                            if ((action.action=='removeguessedkey') && (postCount!=preCount)) await this.setKeysPresentedDiffInc(sessionId,userData,config,postCount-preCount,false);
                            if (this.debug) console.log(sessionId,'afterremovedkey','NewDiff:',userData.keysPresentedDiff);
                            if (userData.knownableWrongs==undefined) userData.knownableWrongs={};
                            userData.knownableWrongs[guessedKey]=0;
                            await this.storeUserData(sessionId,userData);
                        break;
                    case 'removefakekeys':
                            await this.setKeysPresentedDiffInc(sessionId,userData,config,-1*action.number,true);
                            this.stats.statsCounterInc('fake_keys_remove_action','{reason="action"}');
                        break;
                    case 'addfakekeys':
                            await this.setKeysPresentedDiffInc(sessionId,userData,config,action.number,true);
                            this.stats.statsCounterInc('fake_keys_add_action','{reason="action"}');
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
                    case 'restartgame':
                        {
                            this.stats.statsCounterInc('game_restart','{reason="action"}');
                            userData=await this.StartGame(sessionId,userData,config);
                            await this.customLogMessage(sessionId,'extension','Restarted the game','Game has been restarted by action.');
                        }
                        break;                                                    
                    case 'pillory':
                            {
                                const reg=await this.tryRegular('pillory.action',{mode:'non_cumulative',regularity:action.time,waitfirst:false},sessionId,userData);
                                if (reg.userData != undefined ) userData=reg.userData;
                                if (this.debug) console.log(sessionId,'Pillory action cooldown available',reg.result);
                                if (reg.result)
                                {
                                    this.stats.statsCounterInc('pillory','{reason="action"}');
                                    await this.pillory(sessionId,action.time,'Find the key');
                                }
                                else
                                {
                                    this.stats.statsCounterInc('pillory','{reason="cooldown_blocked"}');
                                    
                                }
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
        return(config);
    }
    
    
    async restartGame(req,res)
    {
        let response='';
        let release=null;
        try
        {
            if (this.debug) console.log('RestartGame',req.body.mainToken);
            let session = await this.getSessionForMainToken(req.body.mainToken);
            release = await this.ensureCS(session.session.sessionId, async () => { session=await this.reloadSession(session.session.sessionId,session); });
            let userData=session.session.data;
            //let userData=await this.getUserData(session.session.sessionId);
            if (this.debug) console.log(session.session.sessionId,'Game restart request','Game state',userData.state,'User role',session.role,'Trust state',session?.session?.lock?.trusted);
            if ( ((userData.state == 'finished') && (session.role=="wearer")) || ( (session.role=="keyholder") && (session?.session?.lock?.trusted===true) )  )
            {
                this.stats.statsCounterInc('game_restart','{reason="'+session.role+'"}');
                userData=await this.StartGame(session.session.sessionId,userData,session.session.config);
                const actionData=this.regularActionInfo(session.session);
                this.burnTries(session.session.sessionId,userData,actionData);
                if ((session.role=="wearer")) await this.customLogMessage(session.session.sessionId,'user','Wearer restarted the game','Game has been restarted by wearer.');
            }
            if (release != null) release();
            return res.status(200).send(JSON.stringify({})); 
        }
        catch (err)
        {
            if (release != null) release();
            console.log(err);
            return res.status(501).send('Internal server error');
        }   
    }
    

    async unblock(req,res)
    {
        let response='';
        let release=null;
        try
        {
            let result={};
            let session = await this.getSessionForMainToken(req.body.mainToken);
            release = await this.ensureCS(session.session.sessionId, async () => { session=await this.reloadSession(session.session.sessionId,session); });
            let userData=session.session.data;
            //let userData=await this.getUserData(session.session.sessionId);
            if (this.debug) console.log(session.session.sessionId,'unblock request','Game state',userData.state,'User role',session.role,'Trust state',session?.session?.lock?.trusted);
            if (session.role=="keyholder")
            {
                await this.setReasonsPreventingUnlocking(session.session.sessionId,'');
                await this.customLogMessage(session.session.sessionId,session.role,'Unlocking unblocked','The keyholder unblocked the lock, allowing it to unlock after timer expires.');
            }
            if (release != null) release();
            return res.status(200).send(JSON.stringify(result)); 
        }
        catch (err)
        {
            if (release != null) release();
            console.log(err);
            return res.status(501).send('Internal server error');
        }   
    }

    
    async setBlockers(req,res)
    {
        let response='';
        let release=null;
        try
        {
            let result={};
            let session = await this.getSessionForMainToken(req.body.mainToken);
            release = await this.ensureCS(session.session.sessionId, async () => { session=await this.reloadSession(session.session.sessionId,session); });
            let userData=session.session.data;
            //let userData=await this.getUserData(session.session.sessionId);
            if (this.debug) console.log(session.session.sessionId,'Set blockers request','Game state',userData.state,'User role',session.role,'Trust state',session?.session?.lock?.trusted);
            const newBlockers=req.body.blockers;
            if (this.debug) console.log(session.session.sessionId, 'new blockers',newBlockers);
            if ((session.role=="keyholder") && (session?.session?.lock?.trusted===true))
            {
                userData.blocks=newBlockers;
                await this.storeUserData(session.session.sessionId,userData);
            }
            if (release != null) release();
            return res.status(200).send(JSON.stringify(result)); 
        }
        catch (err)
        {
            if (release != null) release();
            console.log(err);
            return res.status(501).send('Internal server error');
        }   
    }

    async setUnfairs(req,res)
    {
        let response='';
        let release=null;
        try
        {
            let result={};
            let session = await this.getSessionForMainToken(req.body.mainToken);
            release = await this.ensureCS(session.session.sessionId, async () => { session=await this.reloadSession(session.session.sessionId,session); });
            let userData=session.session.data;
            //let userData=await this.getUserData(session.session.sessionId);
            if (this.debug) console.log(session.session.sessionId,'Set unfairs request','Game state',userData.state,'User role',session.role,'Trust state',session?.session?.lock?.trusted);
            const newUnfairs=req.body.unfairs;
            if (this.debug) console.log(session.session.sessionId, 'new unfairs',newUnfairs);
            if ((session.role=="keyholder") && (session?.session?.lock?.trusted===true))
            {
                userData.unfairs=newUnfairs.map ( (u) => {u.source='keyholder'; return (u); });                ;
                await this.storeUserData(session.session.sessionId,userData);
            }
            if (release != null) release();
            return res.status(200).send(JSON.stringify(result)); 
        }
        catch (err)
        {
            if (release != null) release();
            console.log(err);
            return res.status(501).send('Internal server error');
        }   
    }

    async setunfairsettings(req,res)
    {
        let response='';
        let release=null;
        try
        {
            let result={};
            let session = await this.getSessionForMainToken(req.body.mainToken);
            release = await this.ensureCS(session.session.sessionId, async () => { session=await this.reloadSession(session.session.sessionId,session); });
            let userData=session.session.data;
            //let userData=await this.getUserData(session.session.sessionId);
            if (this.debug) console.log(session.session.sessionId,'Set unfair setting request','Game state',userData.state,'User role',session.role,'Trust state',session?.session?.lock?.trusted);
            const unfairsettings=req.body.unfairsettings;
            if (this.debug) console.log(session.session.sessionId, 'new unfairsettings',unfairsettings);
            if ((session.role=="keyholder") && (session?.session?.lock?.trusted===true))
            {
                userData.unfairsetting=unfairsettings;
                await this.storeUserData(session.session.sessionId,userData);
            }
            if (release != null) release();
            return res.status(200).send(JSON.stringify(result)); 
        }
        catch (err)
        {
            if (release != null) release();
            console.log(err);
            return res.status(501).send('Internal server error');
        }   
    }

    async changeKey(req,res)
    {
        let response='';
        let release=null;
        try
        {
            let result={};
            let session = await this.getSessionForMainToken(req.body.mainToken);
            release = await this.ensureCS(session.session.sessionId, async () => { session=await this.reloadSession(session.session.sessionId,session); });
            let userData=session.session.data;
            //let userData=await this.getUserData(session.session.sessionId);
            if (this.debug) console.log(session.session.sessionId,'Change key request','Game state',userData.state,'User role',session.role,'Trust state',session?.session?.lock?.trusted);
            const silent=req.body.silent;
            if (session.role=="keyholder")
            {
                if (session?.session?.lock?.trusted !== true) silent=false;
                userData=this.setNewKey(userData);
                await this.storeUserData(session.session.sessionId,userData);
                if (session.role=="keyholder") 
                {
                    result.newKey=this.encodeKeySpec({key:userData.key,twin:false,obfuscated:false});
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
            if (release != null) release();
            return res.status(200).send(JSON.stringify(result)); 
        }
        catch (err)
        {
            if (release != null) release();
            console.log(err);
            return res.status(501).send('Internal server error');
        }   
    }

    async addFakeKeys(req,res)
    {
        let response='';
        let release=null;
        try
        {
            let result={};
            let session = await this.getSessionForMainToken(req.body.mainToken);
            release = await this.ensureCS(session.session.sessionId, async () => { session=await this.reloadSession(session.session.sessionId,session); });
            let userData=session.session.data;            
            let config=this.sanitizeConfig(session.session.config,userData);
            //let userData=await this.getUserData(session.session.sessionId);
            let addCount=req.body.count;
            if (this.debug) console.log(session.session.sessionId,'AddFakeKeys','Game state',userData.state,'User role',session.role);
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
                        this.stats.statsCounterInc((addCount>0)?'fake_keys_add_action':'fake_keys_remove_action','{reason="keyholder",message="silent"}');
                    }
                    else
                    {
                        if (addCount>0) await this.customLogMessage(session.session.sessionId,session.role,'Added fake keys','Added '+addCount+' fake key'+((addCount>1)?'s':'')+'.');
                        if (addCount<0) await this.customLogMessage(session.session.sessionId,session.role,'Removed fake keys','Removed '+(-1*addCount)+' fake key'+((addCount<-1)?'s':'')+'.');                        
                        if (addCount>0) this.stats.statsCounterInc('fake_keys_added','{reason="keyholder",message="logged"}',addCount);
                        if (addCount<0) this.stats.statsCounterInc('fake_keys_removed','{reason="keyholder",message="logged"}',-1-addCount);
                        this.stats.statsCounterInc((addCount>0)?'fake_keys_add_action':'fake_keys_remove_action','{reason="keyholder",message="logged"}');
                    }
                }
                else
                {
                    this.stats.statsCounterInc((addCount>0)?'fake_keys_add_action':'fake_keys_remove_action','{reason="wearer"}');
                }



            }
            if (release != null) release();
            return res.status(200).send(JSON.stringify(result)); 
        }
        catch (err)
        {
            if (release != null) release();
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

        if ( (data?.data?.actionLog?.extension == 'verification-picture') && (data?.data?.actionLog?.type== 'verification_picture_submitted'))
        {
         let event={event:'verification-picture-submitted',detail:data?.data?.actionLog?.payload, sessionId:data?.data?.sessionId };
         events.push(event);
        }          

        if ( (data?.data?.actionLog?.extension == 'link') && (data?.data?.actionLog?.type== 'link_time_changed'))
        {
         console.log(data?.data?.actionLog?.payload);
         let event={event:'link-time-changed',detail:data?.data?.actionLog?.payload, sessionId:data?.data?.sessionId };
         events.push(event);
        }                  


        if ( (data?.data?.actionLog?.extension == null) && (data?.data?.actionLog?.type== 'time_changed'))
        {
         let event={event:'time_changed',detail:data?.data?.actionLog?.payload?.duration, sessionId:data?.data?.sessionId };
         console.log(data?.data?.actionLog?.payload);
         events.push(event);
        }  

        if ( (data?.data?.actionLog?.extension == 'jigsaw-puzzle') && (data?.data?.actionLog?.type== 'custom') && (data?.data?.actionLog?.title == 'Puzzle completed'))
        {
         let event={event:'jigsaw_completed',detail:null, sessionId:data?.data?.sessionId };
         console.log(data?.data?.actionLog?.payload);
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
        if (e.event=='time_changed')
        {
            if (userData.blocks != undefined)
            {
                userData.blocks = userData.blocks.filter (b => (b.type != 'add_time') || (b.time>e.detail));
                await this.storeUserData(e.sessionId,userData);
            }
        }

        if (e.event=='verification-picture-submitted')
        {
            if (userData.blocks != undefined)
            {
                userData.blocks = userData.blocks.filter (b => (b.type != 'verification') );
                await this.storeUserData(e.sessionId,userData);
            }
        }

        if (e.event=='link-time-changed')
        {
            if (userData.blocks != undefined)
            {
                userData.blocks = userData.blocks.filter (b => (b.type != 'shared_link') );
                await this.storeUserData(e.sessionId,userData);
            }
        }    

        if (e.event=='wheel_of_fortune_turned')
        {
            if (userData.blocks != undefined)
            {
                userData.blocks = userData.blocks.filter (b => (b.type != 'turn_wheel_of_fortune') );
                await this.storeUserData(e.sessionId,userData);
            }
        }   

        if (e.event=='tasks_task_completed')
        {
            if (userData.blocks != undefined)
            {
                userData.blocks = userData.blocks.filter (b => (b.type != 'task_completed') );
                await this.storeUserData(e.sessionId,userData);
            }
        }  
        
        if (e.event=='tasks_task_failed')
        {
            if (userData.blocks != undefined)
            {
                userData.blocks = userData.blocks.filter (b => (b.type != 'task_failed') );
                await this.storeUserData(e.sessionId,userData);
            }
        } 
        
        if (e.event=='jigsaw_completed')
        {
            if (userData.blocks != undefined)
            {
                userData.blocks = userData.blocks.filter (b => (b.type != 'jigsaw_complete') );
                await this.storeUserData(e.sessionId,userData);
            }
        } 

        
        //async processActionList(sessionId,actions,userData,guessedKey)
    }

    async processActionLog(data)
    {
       const release = await this.ensureCS(data?.data?.sessionId);
       try
       { 
        //console.log('Processing action log',data.data);
        const events=this.parseActionLogEvents(data);
        if (events.length > 0)
        {
            if (this.debugWebHooks) console.log('Processing actionlog events:',events);
            events.forEach(async e=> await this.processActionLogEvent(e));
        }
       }
       catch (error)
       {
        console.log('Error processing action log',error);
       }
       release();
    }

    async setKeysPresentedDiffInc(sessionId, userData, config,inc,save=true)
    {
      if (userData.keysPresentedDiff==undefined) userData.keysPresentedDiff=0;
      const logpre=userData.keysPresentedDiff;
      userData.keysPresentedDiff+=inc;
      userData.keysPresentedDiff=Math.min(userData.keysPresentedDiff,100-config.keyspresentedOrig);  
      userData.keysPresentedDiff=Math.max(userData.keysPresentedDiff,-1*config.keyspresentedOrig+1);  
      if (this.debug) console.log(sessionId,'Modifying KeyPresentedDiff','pre:',logpre,'post:',userData.keysPresentedDiff,'config:',config.keyspresented,'configOrig:',config.keyspresentedOrig,'inc:',inc);

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
        if (this.globalMetrics.findomlocks != undefined) 
        {
            metrics += "#HELP findomlocks Current number of locks with findom keyholder\n#TYPE findomlocks gauge\n";
            metrics += "findomlocks "+this.globalMetrics.findomlocks+"\n";
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
        if (this.globalMetrics.keyholders_findom != undefined) 
        {
            metrics += "#HELP keyholders_findom Current number of unique key holders\n#TYPE keyholders_findom gauge\n";
            metrics += "keyholders_findom "+this.globalMetrics.keyholders_findom+"\n";
        }                        
        //if (this.debug) console.log('Generated metrics',metrics);
        return (metrics);
    }

    async prepareGlobalMetrics(cnt=0)
    {
        try
        {
            //const sessions = await  this.findAllSessions(this.slug);
            let sessions=undefined;
            if (cnt%5==0)
               sessions = await  this.findAllSessions(this.slug,50);
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
                let keyholders_findom={};
                let testlocks=0;
                let findomlocks=0;
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
                        if (this.isTrue(s.lock.keyholder.isFindom)) 
                        {
                            keyholders_findom[s.lock.keyholder.username]=s.lock.keyholder.username;
                            findomlocks++;
                        }
                    }
                    if (this.isTrue(s?.lock?.isTestLock)) testlocks += 1;
                });
                this.globalMetrics.testlocks=testlocks;
                this.globalMetrics.keyholdedlocks=keyholdedlocks;
                this.globalMetrics.keyholdedlocks_trusted=keyholdedlocks_trusted;
                this.globalMetrics.findomlocks=findomlocks;
                this.globalMetrics.keyholders=Object.keys(keyholders).length;
                this.globalMetrics.keyholders_findom=Object.keys(keyholders_findom).length;
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
    
    regularActionInfo(session)
    {
        let result =super.regularActionInfo(session);
        if (result.mode =='cumulative')
        {
    
            let userData=session.data;
            if (userData.cumulativeBurned != undefined)
            {
                result.actionsRemainingOrig=result.actionsRemaining;
                result.actionsRemaining=Math.max(0,result.actionsRemaining-userData.cumulativeBurned);
                result.available=result.actionsRemaining>0; 
                //userData.lastGuessed
                if (result.available) { result.nextActionIn=0; }
                else
                {
                    if (this.debug) console.log('Recalculating time till next action ','lastguessed',userData.lastGuessed,typeof userData.lastGuessed);
                    if ((userData.lastGuessed==undefined) || (userData.lastGuessed==null)) { result.nextActionIn=0; }
                    else
                    {
                        const diff=(new Date()-new Date(userData.lastGuessed))/1000;
                        result.nextActionIn=Math.max(0,Math.ceil(result.regularity-diff));
                    }
                    //result.nextActionIn=this.timeRemaining(result.nextActionDate);
                }
                if (this.debug) console.log(session.sessionId,'Modifying cumulative guesses number','remaining pre',result.actionsRemainingOrig,'remaining post',result.actionsRemaining,'burned',userData.cumulativeBurned,'nextActionIn',result.nextActionIn,'available',result.available)
            }
        }
        return (result);
    }


    
}

export {FindTheKey}