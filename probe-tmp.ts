process.env.KAMLIFE_DB_STUB = "1";
process.env.OPENAI_API_KEY = "sk-test-dummy";
process.env.AI_INTEGRATIONS_OPENAI_API_KEY = "sk-test-dummy";
(async () => {
const { scanForSAFoods } = await import("./server/handlers/food-scanner");
const { adjustFoodsForSegment } = await import("./server/handlers/food-context");
for (const c of ["2 eggs","3 eggs","6 eggs","1 egg","half a chicken breast","2 chicken breasts","4 slices of bread","big plate of pap","small bowl of rice"]) {
  const adj = adjustFoodsForSegment(scanForSAFoods(c), c);
  console.log(c, "::", adj.map((f)=>`${f.name} x${f.quantity} ${f.adjustedCalories}kcal/${f.adjustedProtein}p`).join(" ; ")||"NONE");
}
})().catch(e=>console.error("ERR", e.message));
