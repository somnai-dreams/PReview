import { expect, test } from 'bun:test'
import { cell, harness, transfer } from './runtime-harness.test'

const account = (name: string) => ({ account:name,environment:'test' })
test('untrusted parent origins, cross-account state, and changed page accounts cannot write', async () => {
  let current='alice'
  const a=harness({authorize:async()=>account(current)}),b=harness({authorize:async()=>account('bob')}),draft=cell('draft','state','private draft'),target=cell('draft','state','local')
  a.runtime.register(draft);b.runtime.register(target)
  expect(await a.request('capture',undefined,undefined,'https://untrusted.example')).toBeUndefined();expect(a.replies).toHaveLength(0)
  let result=await transfer(a,b)
  expect(result.source.error).toContain('Build accounts or environments do not match');expect(result.target.error).toContain('Build accounts or environments do not match')
  current='bob';result=await transfer(a,b)
  expect(result.source.error).toContain('Build account changed');expect(result.target.error).toContain('Build account changed')
  expect(draft.writes()).toBe(0);expect(target.writes()).toBe(0);expect(JSON.stringify(a.replies)).not.toContain('private draft')
})
test('session verification starts in both frames before data is sent, and either failure closes both ports', async () => {
  for (const failure of [null,'source','destination'] as const) {
    let checks=0,release!:()=>void
    const authorized=new Promise<void>(resolve=>{release=resolve})
    function check(side: 'source'|'destination') { return async()=>{checks++;await authorized;if(side===failure)throw Error('Signed out');return account('alice')} }
    const a=harness({authorize:check('source')}),b=harness({authorize:check('destination')}),target=cell('draft','state','local')
    a.runtime.register(cell('draft','state','incoming'));b.runtime.register(target)
    const ports=new MessageChannel();let closed=0,sentPackets=0
    for(const port of [ports.port1,ports.port2]){
      const close=port.close.bind(port);port.close=()=>{closed++;close()}
      const post=port.postMessage.bind(port);port.postMessage=(value:unknown)=>{if((value as {kind:string}).kind==='packet')sentPackets++;post(value)}
    }
    const pending=Promise.all([b.request('restore',undefined,ports.port2),a.request('capture',undefined,ports.port1)])
    expect(checks).toBe(2);expect(target.writes()).toBe(0);expect(sentPackets).toBe(0)
    release();const replies=await pending
    expect(closed).toBe(2)
    if(failure===null){expect(target.read()).toBe('incoming');expect(sentPackets).toBe(1);expect(replies.every(reply=>reply?.error===undefined)).toBe(true)}
    else{expect(target.writes()).toBe(0);expect(sentPackets).toBe(0);expect(replies.every(reply=>reply?.error?.includes('Signed out'))).toBe(true)}
  }
})
test('native packets preserve shared objects and never send application values to the parent', async()=>{
  const a=harness(),b=harness(),row={title:'private job'},source=cell('jobs','ref',{first:row,selected:row}),target=cell('jobs','ref',null)
  a.runtime.register(source);b.runtime.register(target)
  const ports=new MessageChannel(),post=ports.port1.postMessage.bind(ports.port1)
  let received: {first:object;selected:object}|undefined
  ports.port1.postMessage=(value:unknown)=>{
    const message=structuredClone(value) as {kind:string;packet?:{data:{values:{first:object;selected:object}[]}}}
    if(message.kind==='packet')received=message.packet!.data.values[0]
    post(value)
  }
  await Promise.all([b.request('restore',undefined,ports.port2),a.request('capture',undefined,ports.port1)])
  expect(received!.first).toBe(received!.selected);expect(received!.first).not.toBe(row)
  expect(target.read()).toEqual({first:row,selected:row})
  for(const replies of[a.replies,b.replies]){
    const text=JSON.stringify(replies)
    expect(text).not.toContain('private job');expect(text).not.toContain('"session"');expect(text).not.toContain('"history"');expect(text).not.toContain('"values"')
  }
})
test('destination rejects a forged account envelope even after its own account check passes',async()=>{
  const b=harness({authorize:async()=>account('alice')}),target=cell('draft','state','local');b.runtime.register(target)
  const ports=new MessageChannel()
  const offer=new Promise<void>(resolve=>{ports.port1.onmessage=event=>{if(event.data.kind==='offer')resolve()}})
  const pending=b.request('restore',undefined,ports.port2)
  await offer
  ports.port1.postMessage({kind:'packet',context:{session:account('bob')},packet:{}})
  const result=await pending;ports.port1.close()
  expect(result?.error).toContain('Build accounts or environments do not match');expect(target.writes()).toBe(0)
})
