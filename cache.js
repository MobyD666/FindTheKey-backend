class  Cache
{
    constructor()
    { 
    }

    store(key, value,timeOut=null)
    {

    }

    get(key)
    {

    }

    invalidate(key)
    {

    }


}

class MemoryCache extends Cache
{
    constructor()
    { 
        super();
        this.data={};
        //setInterval( () => console.log('cachedump',this.data),60000);
    }

    store(key, value,timeout=null)
    {
        this.data[key]={valid:true,value:value,timeout:(timeout==null)?null:Date.now()+timeout*1000};
    }

    get(key)
    {
        if (this.data[key]?.valid===true)
        {
            if ((this.data[key].timeout==null) || (Date.now()<=this.data[key].timeout)) return(this.data[key].value);
            this.invalidate(key);
        }
        return (null);
    }

    invalidate(key)
    {
        //console.log('invalidating ',key,this.data[key]);
        if (this.data[key]?.valid===true) this.data[key].valid=false;    
    }


}
    

export {Cache,MemoryCache};