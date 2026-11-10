import json,hashlib,sys
H=lambda *p: hashlib.sha256(b''.join(p)).digest()
def be(x): return x.to_bytes(16,'big')
def s(x): b=x.encode(); return len(b).to_bytes(4,'big')+b
def commit(pr,sz,salt,who,sale): return H(be(pr),be(sz),salt,s(who),s(sale))
def leaf(l): return H(b'\0',s(l[0]),be(l[1]),be(l[2]))
def root(ls):
    if not ls: return bytes(32)
    while len(ls)>1:
        ls=[H(b'\1',ls[i],ls[i+1]) if i+1<len(ls) else ls[i] for i in range(0,len(ls),2)]
    return ls[0]
def cdiv(a,b): return -(-a//b)
def clear(P,es):
    sup,res,dec,mn,sale=int(P['supply']),int(P['reserve']),P['token_decimals'],int(P['min_size']),P['sale_id']
    sc=10**dec; out=[None]*len(es); valid=[]
    for i,e in enumerate(es):
        pt=e['plaintext']
        if pt is None: out[i]=('dropped',1);continue
        pr,sz,salt=int(pt['price']),int(pt['size']),bytes.fromhex(pt['salt'])
        if commit(pr,sz,salt,e['bidder'],sale).hex()!=e['commit']: out[i]=('dropped',2)
        elif pr==0 or sz==0 or sz<mn or sz>2**100: out[i]=('dropped',3)
        elif pr<res: out[i]=('dropped',4)
        elif cdiv(pr*sz,sc)>int(e['deposit']): out[i]=('dropped',5)
        else: out[i]=('filled',0); valid.append((i,pr,sz))
    prices=sorted({v[1] for v in valid},reverse=True); cum=0; ps=res; fill={}
    for pr in prices:
        lvl=[v for v in valid if v[1]==pr]; m=sum(v[2] for v in lvl)
        if cum+m>=sup:
            ps=pr; R=sup-cum
            base={v[0]:v[2]*R//m for v in lvl}; rem={v[0]:v[2]*R%m for v in lvl}
            left=R-sum(base.values())
            order=sorted([i for i in rem if rem[i]>0],key=lambda i:(-rem[i],es[i]['commit'],i))
            for i in order[:left]: base[i]+=1
            fill.update(base)
            for v in valid:
                if v[1]>pr: fill[v[0]]=v[2]
                elif v[1]<pr: fill[v[0]]=0
            sold=sup;burn=0;break
        cum+=m
    else:
        for v in valid: fill[v[0]]=v[2]
        sold=cum;burn=sup-cum
    for i,f in fill.items(): out[i]=('filled',f)
    agg={}
    for i,e in enumerate(es):
        a=agg.setdefault(e['bidder'],[0,0]); a[1]+=int(e['deposit'])
        if out[i][0]=='filled': a[0]+=out[i][1]
    leaves=[];raise_=0
    for b in sorted(agg,key=lambda x:x.encode()):
        t,d=agg[b]; c=cdiv(ps*t,sc); raise_+=c
        if t==0 and d-c==0: continue
        leaves.append((b,t,d-c))
    return dict(p=ps,sold=sold,burn=burn,raise_=raise_,leaves=leaves,root=root([leaf(l) for l in leaves]).hex(),out=out)
doc=json.load(open('vectors.json')); bad=0
for c in doc['clearing_vectors']:
    r=clear(c['params'],c['entries']); e=c['expected']
    ok=(str(r['p'])==e['p_star'] and str(r['sold'])==e['sold'] and str(r['burn'])==e['burned'] and str(r['raise_'])==e['raise']
        and r['root']==e['alloc_root'] and [(l['bidder'],int(l['tokens']),int(l['refund'])) for l in e['leaves']]==r['leaves'])
    for o,eo in zip(r['out'],e['outcomes']):
        ok&= (eo.get('filled')==str(o[1]) if o[0]=='filled' else eo.get('code')==o[1])
    print(c['name'],'OK' if ok else 'MISMATCH'); bad+=not ok
for c in doc['commit_vectors']:
    ok=commit(int(c['price']),int(c['size']),bytes.fromhex(c['salt']),c['bidder'],c['sale']).hex()==c['commit']; print('commit',ok); bad+=not ok
for m in doc['merkle_vectors']:
    ok=root([bytes.fromhex(x) for x in m['leaf_hashes']]).hex()==m['root']; print('merkle',m['n'],ok); bad+=not ok
sys.exit(bad)
