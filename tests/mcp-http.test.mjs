import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {ToolRegistry,Budget} from '../dist/index.js';
import {connectMcp} from '../dist/integrations/mcp.js';
import {boundedFetch} from '../dist/integrations/bounded-fetch.js';
const secret='fixture-http-secret-not-real';

async function fixture(mode='normal'){
  const server=createServer(async(request,response)=>{
    if(mode==='leak-error'){response.writeHead(500);response.end(request.headers.authorization);return;}
    if(mode==='oversize'){response.end('x'.repeat(1048577));return;}
    if(request.method!=='POST'){response.writeHead(405);response.end();return;}
    let raw='';for await(const chunk of request)raw+=chunk;
    const message=JSON.parse(raw);
    if(message.id===undefined){response.writeHead(202);response.end();return;}
    if(request.headers.authorization!==`Bearer ${secret}`){response.writeHead(401);response.end();return;}
    let result;
    if(message.method==='initialize')result={protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1.0.0'}};
    if(message.method==='tools/list')result={tools:[{name:'echo',description:mode==='leak-metadata'?secret:'Echo test',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']}}]};
    if(message.method==='tools/call'){
      if(mode==='slow')await new Promise(resolve=>setTimeout(resolve,150));
      result=mode==='leak-key'?{content:[],structuredContent:{[secret]:'value'}}:{content:[{type:'text',text:message.params.arguments.text}]};
    }
    response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({jsonrpc:'2.0',id:message.id,result}));
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const config={id:'httpfixture',transport:'http',url:`http://127.0.0.1:${server.address().port}`,tools:['echo'],expectedVersion:'1.0.0',bearerEnv:'TEST_MCP_BEARER'};
  return {config,close:()=>new Promise(resolve=>server.close(resolve))};
}
function context(name,signal=new AbortController().signal){return {owner:'test',workspace:'.',runId:'test',signal,budget:new Budget(),permissions:new Set([name]),depth:0};}

test('MCP HTTP performs authenticated initialization/discovery/tool call',async()=>{
  const host=await fixture();const registry=new ToolRegistry();let connection;
  try{
    connection=await connectMcp(registry,host.config,{TEST_MCP_BEARER:secret});
    const result=await registry.execute(connection.tools[0],{text:'HTTP works'},context(connection.tools[0]));
    assert.equal(result.content[0].text,'HTTP works');
  }finally{await connection?.close();await host.close();}
});

test('MCP startup errors and metadata do not expose configured bearer values',async()=>{
  for(const mode of ['leak-error','leak-metadata']){
    const host=await fixture(mode);const registry=new ToolRegistry();
    try{await assert.rejects(connectMcp(registry,host.config,{TEST_MCP_BEARER:secret}),error=>!error.message.includes(secret)&&/MCP connection failed/.test(error.message));assert.deepEqual(registry.permissions(),[]);}
    finally{await host.close();}
  }
});

test('MCP secrets embedded in property names are rejected and cancellation propagates',async()=>{
  for(const mode of ['leak-key','slow']){
    const host=await fixture(mode);const registry=new ToolRegistry();let connection;
    try{
      connection=await connectMcp(registry,host.config,{TEST_MCP_BEARER:secret});
      const signal=mode==='slow'?AbortSignal.timeout(30):new AbortController().signal;
      await assert.rejects(registry.execute(connection.tools[0],{text:'hello'},context(connection.tools[0],signal)),error=>!error.message.includes(secret));
    }finally{await connection?.close();await host.close();}
  }
});

test('MCP HTTP byte cap rejects oversized bodies before JSON parsing',async()=>{
  const host=await fixture('oversize');
  try{const response=await boundedFetch(host.config.url);await assert.rejects(response.text(),/1 MiB/);}
  finally{await host.close();}
});
