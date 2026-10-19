import json, copy, os
base = json.load(open("engine-rs/configs/v4.2-ultra.json"))
os.makedirs("ml/data/seat/configs", exist_ok=True)
def put(name, f):
    c = copy.deepcopy(base); f(c)
    json.dump(c, open(f"ml/data/seat/configs/{name}.json", "w"), indent=1)
put("rb0",    lambda c: c["search"].__setitem__("rankBlend", 0.0))
put("rb70",   lambda c: c["search"].__setitem__("rankBlend", 0.7))
put("rb100",  lambda c: c["search"].__setitem__("rankBlend", 1.0))
put("flat",   lambda c: c.__setitem__("seats", [{k: 1.0 for k in s} for s in c["seats"]]))
put("agg140", lambda c: c.__setitem__("aggressionScale", 1.4))
put("agg60",  lambda c: c.__setitem__("aggressionScale", 0.6))
print(sorted(os.listdir("ml/data/seat/configs")))
