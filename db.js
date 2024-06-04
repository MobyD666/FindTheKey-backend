import postgres_node from 'pg';
const { Pool } = postgres_node;

class  DB
{
    constructor(config)
    {
        this.pgpool = new Pool(
            {
                user: config.PGUSER,
                host: config.PGHOST,
                database: config.PGDB,
                password: config.PGPASS,
                port: config.PGPORT,
            });
    }

    async query(query,data=null)
    {
      let res=null;
      if (data != undefined) res = await this.pgpool.query(query, data); else res = await this.pgpool.query(query);    
      return (res);
    }


    //await this.pgpool.query('INSERT INTO public.messages (sessionid, data, type,tstamp) VALUES ($1, $2, $3, NOW()) RETURNING *', [sessionid,data,type]);
    //let res=await this.pgpool.query(' select message_id from view_last_message_id where sessionid=$1', [sessionid]);
    //if (res.rowCount!=1) return (null);
    //return (res.rows[0]["message_id"]);
    //res.rows.forEach(r=>result.push(r.flag));


}

export {DB};
