import { buildClientSnapshot } from "./server/brain/client-snapshot";
const u = { id: "u1", name: "Kam", goalType: "muscle_gain", calorieTarget: 2996, proteinTarget: 199, stepsTarget: 11000, currentWeight: "83", trainingMode: "gym", createdAt: new Date(Date.now()-42*86400000) };
const s = await buildClientSnapshot(u as any).catch((e)=>"ERR:"+e.message);
console.log("SNAPSHOT LEN:", s.length);
console.log(s.slice(0, 300));
