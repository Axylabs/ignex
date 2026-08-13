import json

s = json.load(
    open(
        "/home/adeel/poc/ignus/node_modules/.bun/@biomejs+biome@2.5.5/node_modules/@biomejs/biome/configuration_schema.json"
    )
)
rules = s["$defs"]["Rules"]
targets = [
    "noUselessElse",
    "noExcessiveCognitiveComplexity",
    "noUselessCatch",
    "noUselessTernary",
    "noUselessStringConcat",
    "useConst",
    "noParameterAssign",
    "noCommaOperator",
    "noAssignInExpressions",
    "useMaxParams",
    "useArrowFunction",
    "useFlatMap",
    "noAccumulatingSpread",
]
for group in ["style", "complexity", "suspicious", "correctness", "performance", "nursery"]:
    props = rules["properties"][group]["properties"]
    names = set(props.keys())
    for target in targets:
        if target in names:
            print(group, target)
