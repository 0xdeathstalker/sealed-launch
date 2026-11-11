import { view } from "../src/lib/chain.ts";
const [acc, m, args="{}"] = process.argv.slice(2);
console.log(JSON.stringify(await view(acc, m, JSON.parse(args)), null, 1));
