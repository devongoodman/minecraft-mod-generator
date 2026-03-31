const express = require("express");
const { GoogleGenAI } = require("@google/genai");
const archiver = require("archiver");
const path = require("path");
const { PNG } = require("pngjs");

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

const PORT = 3001;

// Convert a 16x16 grid of hex colors to a PNG base64 string
function pixelGridToPng(grid) {
  const png = new PNG({ width: 16, height: 16 });
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const hex = (grid[y] && grid[y][x]) || "00000000";
      const idx = (16 * y + x) * 4;
      if (hex === "." || hex === "00000000" || hex === "transparent") {
        png.data[idx] = 0;
        png.data[idx + 1] = 0;
        png.data[idx + 2] = 0;
        png.data[idx + 3] = 0;
      } else {
        const clean = hex.replace("#", "");
        const r = parseInt(clean.substring(0, 2), 16) || 0;
        const g = parseInt(clean.substring(2, 4), 16) || 0;
        const b = parseInt(clean.substring(4, 6), 16) || 0;
        const a = clean.length === 8 ? (parseInt(clean.substring(6, 8), 16) || 255) : 255;
        png.data[idx] = r;
        png.data[idx + 1] = g;
        png.data[idx + 2] = b;
        png.data[idx + 3] = a;
      }
    }
  }
  const buffer = PNG.sync.write(png);
  return buffer.toString("base64");
}

// Generate a texture image for the item using text AI to describe pixels
app.post("/api/generate-texture", async (req, res) => {
  const { itemName, itemAppearance, apiKey } = req.body;

  if (!itemName || !apiKey) {
    return res.status(400).json({ error: "Missing item name or API key" });
  }

  try {
    const ai = new GoogleGenAI({ apiKey });

    console.log("Generating texture via pixel grid...");

    // Use compact format: 16 lines of 16 hex codes separated by commas
    // "." = transparent, otherwise 6-char hex. Much less tokens than JSON arrays.
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: `Create a 16x16 pixel art Minecraft item texture for: "${itemName}".
Appearance: ${itemAppearance || itemName}.

Output 16 lines. Each line has 16 values separated by commas.
Each value is either . (transparent) or a 6-char hex color (no # symbol).

Example of a red sword (for reference only):
.,.,.,.,.,.,.,.,.,.,.,.,.,.,.,.
.,.,.,.,.,.,.,.,.,.,.,.,.,FF0000,CC0000,.
.,.,.,.,.,.,.,.,.,.,.,.,FF0000,FF3333,.,.
.,.,.,.,.,.,.,.,.,.,.,FF0000,FF3333,.,.,.
.,.,.,.,.,.,.,.,.,.,FF0000,FF3333,.,.,.,.
.,.,.,.,.,.,.,.,.,FF0000,FF3333,.,.,.,.,.
.,.,.,.,.,.,.,.,FF0000,FF3333,.,.,.,.,.,.
.,.,.,.,.,.,.,FF0000,FF3333,.,.,.,.,.,.,.
.,.,.,.,.,.,FF0000,FF3333,.,.,.,.,.,.,.,.
.,.,.,.,.,FF0000,FF3333,.,.,.,.,.,.,.,.,.
.,.,.,.,8B4513,CC0000,.,.,.,.,.,.,.,.,.,.
.,.,.,8B4513,DAA520,.,.,.,.,.,.,.,.,.,.,.
.,.,8B4513,DAA520,.,.,.,.,.,.,.,.,.,.,.,.
.,8B4513,DAA520,.,.,.,.,.,.,.,.,.,.,.,.,.
8B4513,DAA520,.,.,.,.,.,.,.,.,.,.,.,.,.,.
8B4513,.,.,.,.,.,.,.,.,.,.,.,.,.,.,.

Now generate for "${itemName}". Swords go diagonal, tools vertical, armor shaped. Use color shading. Most pixels should be transparent (.).
Output EXACTLY 16 lines of 16 comma-separated values. Nothing else.`,
      config: {
        maxOutputTokens: 3000,
        thinkingConfig: { thinkingBudget: 0 },
      },
    });

    let imageBase64 = null;
    const text = response.candidates[0].content.parts[0].text;
    console.log("AI pixel response length:", text.length);
    try {
      let cleaned = text.trim();
      // Strip markdown fences
      if (cleaned.startsWith("```")) {
        cleaned = cleaned.replace(/^```\w*\n?/, "").replace(/\n?```$/, "");
      }
      // Parse CSV-style lines into a grid
      const lines = cleaned.split("\n").map(l => l.trim()).filter(l => l.length > 0 && l.includes(","));
      console.log("Parsed", lines.length, "lines");
      if (lines.length >= 16) {
        const grid = lines.slice(0, 16).map(line => {
          return line.split(",").map(v => v.trim()).slice(0, 16);
        });
        // Pad rows to 16 if needed
        for (const row of grid) {
          while (row.length < 16) row.push(".");
        }
        imageBase64 = pixelGridToPng(grid);
        console.log("Texture generated from pixel grid successfully");
      } else {
        console.error("Not enough lines, got:", lines.length);
      }
    } catch (parseErr) {
      console.error("Failed to parse pixel grid:", parseErr.message);
      console.error("Raw response (first 500 chars):", text.substring(0, 500));
    }

    res.json({ imageBase64 });
  } catch (err) {
    console.error("Texture generation error:", err.message);
    res.json({ imageBase64: null, warning: err.message });
  }
});

app.post("/api/generate", async (req, res) => {
  const { itemName, fileName, itemDescription, itemAppearance, extraDetails, edition, apiKey, textureBase64 } = req.body;

  if (!itemName || !edition || !apiKey) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  if (edition !== "bedrock") {
    return res.status(400).json({ error: "Only Bedrock Edition is supported" });
  }

  const ai = new GoogleGenAI({ apiKey });
  const isItemMod = itemAppearance && itemAppearance.trim().length > 0;

  console.log("\n[MODE]", isItemMod ? "ITEM MOD" : "GENERAL MOD");

  const itemDetails = isItemMod
    ? `Item Name: ${itemName}
File/Mod Name: ${fileName || itemName.toLowerCase().replace(/\s+/g, "-")}
Description: ${itemDescription || "A custom item"}
Appearance: ${itemAppearance}
Additional Details: ${extraDetails || "None"}
${textureBase64 ? "NOTE: A texture image has already been generated and will be included automatically. Include the correct texture path in your files but do NOT generate image content - just put a placeholder string for any .png file content." : "NOTE: No texture was generated. Do NOT include any .png files."}`
    : `Mod Name: ${itemName}
File/Mod Name: ${fileName || itemName.toLowerCase().replace(/\s+/g, "-")}
Description: ${itemDescription || "A custom mod"}
Additional Details: ${extraDetails || "None"}
NOTE: This is NOT an item mod. Do NOT generate items or textures. Generate behavior packs, scripts, entities, or whatever is needed for this mod.`;

  const systemPrompt = edition === "java"
    ? `You are an expert Minecraft Java Edition mod developer. You generate complete, working mod projects using Forge (1.20.x).

When generating a mod, output ALL files needed as a JSON array of objects with "path" and "content" keys.

Always include:
- build.gradle
- settings.gradle
- gradle.properties
- src/main/java/ source files (package based on mod id)
- src/main/resources/META-INF/mods.toml
- src/main/resources/pack.mcmeta

Use modern Forge conventions (1.20.x). Make the mod functional and complete.
Output ONLY the JSON array, no markdown fences, no explanation.`
    : `You are an expert Minecraft Bedrock Edition add-on developer. You generate complete, working behavior packs and resource packs.

When generating an add-on, output ALL files needed as a JSON array of objects with "path" and "content" keys.

=== ITEM DEFINITION FORMAT (behavior_pack/items/<id>.json) ===
You MUST use format_version "1.20.50" for items. Here is an example of a custom sword item:
{
  "format_version": "1.20.50",
  "minecraft:item": {
    "description": {
      "identifier": "mymod:my_sword",
      "menu_category": {
        "category": "equipment",
        "group": "itemGroup.name.sword"
      }
    },
    "components": {
      "minecraft:display_name": {
        "value": "My Sword"
      },
      "minecraft:icon": {
        "textures": {
          "default": "mymod_my_sword"
        }
      },
      "minecraft:max_stack_size": 1,
      "minecraft:damage": {
        "value": 10
      },
      "minecraft:hand_equipped": true,
      "minecraft:durability": {
        "max_durability": 500
      },
      "minecraft:enchantable": {
        "value": 14,
        "slot": "sword"
      },
      "minecraft:repairable": {
        "repair_items": [
          {
            "items": ["minecraft:diamond"],
            "repair_amount": "context.other->q.remaining_durability + 0.05 * context.other->q.max_durability"
          }
        ]
      }
    }
  }
}

CRITICAL ITEM RULES:
- ALWAYS include "minecraft:display_name" with the item's name so it shows in-game
- ALWAYS include "minecraft:icon" pointing to the texture short name
- If the item does damage, set "minecraft:max_stack_size" to 1
- If the item is a weapon/tool, set "minecraft:hand_equipped" to true
- Use "minecraft:damage" for attack damage. IMPORTANT: Bedrock clamps damage to 231 max.
  If the user wants damage higher than 231 (e.g. "one shot kill", "1000 damage", "instant kill"),
  you MUST use a script approach instead. Add a script module to the behavior pack manifest and
  create a script file like behavior_pack/scripts/main.js that listens for entity hit events:

  import { world } from "@minecraft/server";
  world.afterEvents.entityHitEntity.subscribe((event) => {
    const source = event.damagingEntity;
    const target = event.hitEntity;
    const equip = source.getComponent("minecraft:equippable");
    if (equip) {
      const mainhand = equip.getEquipment("Mainhand");
      if (mainhand && mainhand.typeId === "mymod:my_sword") {
        target.applyDamage(1000);
      }
    }
  });

  When using scripts, the behavior pack manifest needs:
  - A script module: { "type": "script", "uuid": "<uuid>", "version": [1,0,0], "entry": "scripts/main.js", "language": "javascript" }
  - A dependency on @minecraft/server: { "module_name": "@minecraft/server", "version": "1.17.0-beta" }
  Set "minecraft:damage" to 1 on the item itself (the script handles the real damage).
- Use "minecraft:durability" for how long it lasts
- Use "minecraft:food" for food items with saturation/nutrition
- Use "minecraft:armor" for armor pieces
- The identifier must be "namespace:item_name" format (e.g. "mymod:ruby_sword")
- ALWAYS include menu_category in the description so the item appears in creative inventory
- Valid categories: "construction", "nature", "equipment", "items", "none"
- Valid groups for equipment: "itemGroup.name.sword", "itemGroup.name.axe", "itemGroup.name.pickaxe", "itemGroup.name.shovel", "itemGroup.name.hoe"
- The namespace should be simple and short, like the mod name in lowercase with no spaces
- DO NOT use scripts unless absolutely necessary (e.g. damage > 231). Scripts require experimental mode which many users don't enable. Prefer pure JSON data-driven definitions.

=== TEXTURE WIRING (resource_pack/textures/item_texture.json) ===
This file maps texture short names to texture file paths. ALWAYS include this:
{
  "resource_pack_name": "My Addon",
  "texture_name": "atlas.items",
  "texture_data": {
    "mymod_my_sword": {
      "textures": "textures/items/my_sword"
    }
  }
}
The short name (e.g. "mymod_my_sword") must match what you put in "minecraft:icon".
The texture path must NOT include the .png extension.
ALWAYS include the texture PNG at: resource_pack/textures/items/<item_name>.png
Use "TEXTURE_PLACEHOLDER" as the content for .png files.

=== RECIPE FORMAT (behavior_pack/recipes/<id>.json) ===
If crafting is described, include a recipe file:
{
  "format_version": "1.12",
  "minecraft:recipe_shaped": {
    "description": { "identifier": "mymod:my_sword_recipe" },
    "tags": ["crafting_table"],
    "pattern": [" G ", " G ", " S "],
    "key": {
      "G": { "item": "minecraft:diamond" },
      "S": { "item": "minecraft:stick" }
    },
    "result": { "item": "mymod:my_sword", "count": 1 }
  }
}

=== MANIFEST FORMAT ===
behavior_pack/manifest.json:
{
  "format_version": 2,
  "header": {
    "name": "Addon Name BP",
    "description": "Description",
    "uuid": "<valid random UUID v4>",
    "version": [1, 0, 0],
    "min_engine_version": [1, 20, 0]
  },
  "modules": [{ "type": "data", "uuid": "<different UUID>", "version": [1, 0, 0] }]
}

resource_pack/manifest.json:
{
  "format_version": 2,
  "header": {
    "name": "Addon Name RP",
    "description": "Description",
    "uuid": "<valid random UUID v4>",
    "version": [1, 0, 0],
    "min_engine_version": [1, 20, 0]
  },
  "modules": [{ "type": "resources", "uuid": "<different UUID>", "version": [1, 0, 0] }],
  "dependencies": [{ "uuid": "<behavior pack header uuid>", "version": [1, 0, 0] }]
}

=== RULES ===
- Every UUID must be unique valid v4 (8-4-4-4-12 hex)
- Manifest version/min_engine_version must be integer arrays, format_version must be integer 2
- Item format_version must be the STRING "1.20.50"
- File paths must start with behavior_pack/ or resource_pack/
- For .png files, use "TEXTURE_PLACEHOLDER" as content
- ALWAYS include: both manifests, item definition, item_texture.json, texture .png, and recipe if crafting was described
- DO NOT use scripts unless absolutely necessary - prefer JSON data-driven definitions

Output ONLY the JSON array, no markdown fences, no explanation.`;

  // For non-item mods, use a more flexible prompt
  const generalBedrockPrompt = `You are an expert Minecraft Bedrock Edition add-on developer. You create all types of mods including custom entities, bosses, gameplay changes, visual effects, and game mechanics using behavior packs, resource packs, and scripts.

When generating an add-on, output ALL files needed as a JSON array of objects with "path" and "content" keys.

You can create:
- Custom entities/mobs/bosses (behavior_pack/entities/*.json + resource_pack/entity/*.json + resource_pack/models/entity/*.json)
- Scripts for gameplay changes (behavior_pack/scripts/main.js using @minecraft/server API)
- Custom particles, animations, sounds
- Modified game rules and mechanics
- Loot tables, spawn rules, trade tables

Manifest requirements:
- behavior_pack/manifest.json and resource_pack/manifest.json are REQUIRED
- format_version must be integer 2
- All UUIDs must be valid v4 format (8-4-4-4-12 hex), all unique
- version and min_engine_version must be integer arrays [1, 20, 0]
- BP module type: "data" (or "script" if using scripts)
- RP module type: "resources"
- RP must have dependency on BP header uuid

If using scripts:
- Add a script module: { "type": "script", "uuid": "<uuid>", "version": [1,0,0], "entry": "scripts/main.js", "language": "javascript" }
- Add dependency: { "module_name": "@minecraft/server", "version": "1.16.0" }
- Use import { world, system } from "@minecraft/server"

Recipe format_version must be "1.12".
Entity format_version should be "1.20.50".
File paths must start with behavior_pack/ or resource_pack/.
Do NOT include any .png files.

Output ONLY the JSON array, no markdown fences, no explanation.`;

  // Pick the right prompt
  const finalSystemPrompt = edition === "bedrock" && !isItemMod ? generalBedrockPrompt : systemPrompt;

  try {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    let fullResponse = "";

    const stream = await ai.models.generateContentStream({
      model: "gemini-2.5-flash",
      contents: `Generate a Minecraft ${edition === "java" ? "Java Edition Forge" : "Bedrock Edition"} mod/add-on with these details:\n${itemDetails}`,
      config: {
        systemInstruction: finalSystemPrompt,
        maxOutputTokens: 16000,
      },
    });

    for await (const chunk of stream) {
      const text = chunk.text;
      if (text) {
        fullResponse += text;
        res.write(`data: ${JSON.stringify({ type: "progress", text })}\n\n`);
      }
    }

    // Parse the generated files
    let files;
    try {
      let cleaned = fullResponse.trim();
      if (cleaned.startsWith("```")) {
        cleaned = cleaned.replace(/^```\w*\n?/, "").replace(/\n?```$/, "");
      }
      files = JSON.parse(cleaned);
    } catch {
      res.write(`data: ${JSON.stringify({ type: "error", error: "Failed to parse AI response. Try again." })}\n\n`);
      res.end();
      return;
    }

    if (!isItemMod) {
      // === GENERAL MOD MODE ===
      // Trust the AI output, only fix manifests
      console.log("\n========== GENERAL MOD BUILD ==========");
      console.log("Mod:", itemName);
      console.log("Files from AI:", files.length);

      // Fix manifests with valid UUIDs
      files = fixManifest(files);

      // Remove any .png placeholders
      files = files.filter(f => !f.path.endsWith(".png") || f.isBinary);

      console.log("[FILES IN PACK]");
      files.forEach(f => console.log("  " + f.path));
      console.log("======================================\n");

      res.write(`data: ${JSON.stringify({ type: "done", files })}\n\n`);
      res.end();
      return;
    }

    // === ITEM MOD MODE - BUILD CRITICAL FILES FROM SCRATCH ===
    // The AI output is only used for the recipe pattern/ingredients.
    // Everything else is built server-side to guarantee correctness.

    const safeItemName = itemName.toLowerCase().replace(/[^a-z0-9]/g, "_");
    const namespace = (fileName || itemName).toLowerCase().replace(/[^a-z0-9]/g, "") || "mod";
    const itemId = `${namespace}:${safeItemName}`;
    const shortName = `${namespace}_${safeItemName}`;

    // Parse damage from extraDetails
    let damage = 7; // default sword damage
    const dmgMatch = (extraDetails || "").match(/(\d+)\s*damage/i);
    if (dmgMatch) damage = Math.min(parseInt(dmgMatch[1]), 231);

    // Parse durability from extraDetails
    let durability = 500;
    const durMatch = (extraDetails || "").match(/(\d+)\s*durability/i);
    if (durMatch) durability = parseInt(durMatch[1]);

    // Detect item type from name/description
    const lowerName = itemName.toLowerCase();
    const lowerDesc = (itemDescription + " " + extraDetails).toLowerCase();
    const isSword = /sword|blade|katana|dagger|saber/i.test(lowerName);
    const isAxe = /\baxe\b/i.test(lowerName);
    const isPickaxe = /pick/i.test(lowerName);
    const isShovel = /shovel|spade/i.test(lowerName);
    const isHoe = /\bhoe\b/i.test(lowerName);
    const isTool = isSword || isAxe || isPickaxe || isShovel || isHoe;
    const isFood = /food|eat|hunger|saturation/i.test(lowerDesc);
    const isArmor = /armor|helmet|chestplate|leggings|boots/i.test(lowerName);

    let menuCategory = "items";
    let menuGroup = "";
    if (isSword) { menuCategory = "equipment"; menuGroup = "itemGroup.name.sword"; }
    else if (isAxe) { menuCategory = "equipment"; menuGroup = "itemGroup.name.axe"; }
    else if (isPickaxe) { menuCategory = "equipment"; menuGroup = "itemGroup.name.pickaxe"; }
    else if (isShovel) { menuCategory = "equipment"; menuGroup = "itemGroup.name.shovel"; }
    else if (isHoe) { menuCategory = "equipment"; menuGroup = "itemGroup.name.hoe"; }
    else if (isArmor) { menuCategory = "equipment"; }

    // Build item components
    const components = {
      "minecraft:display_name": { value: itemName },
      "minecraft:icon": { textures: { default: shortName } },
    };

    if (isTool || isArmor) {
      components["minecraft:max_stack_size"] = 1;
      components["minecraft:hand_equipped"] = true;
      components["minecraft:damage"] = { value: damage };
      components["minecraft:durability"] = { max_durability: durability };
      components["minecraft:enchantable"] = { value: 14, slot: isSword ? "sword" : (isAxe ? "axe" : "sword") };
    }

    if (isFood) {
      const nutritionMatch = lowerDesc.match(/(\d+)\s*(?:nutrition|hunger)/);
      const saturationMatch = lowerDesc.match(/(\d+(?:\.\d+)?)\s*saturation/);
      components["minecraft:food"] = {
        nutrition: nutritionMatch ? parseInt(nutritionMatch[1]) : 4,
        saturation_modifier: saturationMatch ? parseFloat(saturationMatch[1]) : 0.6,
        can_always_eat: false,
      };
      components["minecraft:use_animation"] = "eat";
      components["minecraft:max_stack_size"] = 64;
    }

    if (!isTool && !isArmor && !isFood) {
      components["minecraft:max_stack_size"] = 64;
    }

    // Build the item definition
    const menuCategoryObj = { category: menuCategory };
    if (menuGroup) menuCategoryObj.group = menuGroup;

    const itemDef = {
      format_version: "1.21.10",
      "minecraft:item": {
        description: {
          identifier: itemId,
          menu_category: menuCategoryObj,
        },
        components,
      },
    };

    // Build manifests
    const bpUuid = randomUUID();
    const rpUuid = randomUUID();

    const bpManifest = {
      format_version: 2,
      header: { name: `${itemName} BP`, description: itemDescription || `Adds ${itemName}`, uuid: bpUuid, version: [1, 0, 0], min_engine_version: [1, 21, 0] },
      modules: [{ type: "data", uuid: randomUUID(), version: [1, 0, 0] }],
    };

    const rpManifest = {
      format_version: 2,
      header: { name: `${itemName} RP`, description: itemDescription || `Adds ${itemName}`, uuid: rpUuid, version: [1, 0, 0], min_engine_version: [1, 21, 0] },
      modules: [{ type: "resources", uuid: randomUUID(), version: [1, 0, 0] }],
      dependencies: [{ uuid: bpUuid, version: [1, 0, 0] }],
    };

    // Extract recipe from AI output and fix it
    let recipeFile = null;
    for (const f of files) {
      if (f.path.includes("/recipes/") && f.path.endsWith(".json")) {
        try {
          const recipe = typeof f.content === "string" ? JSON.parse(f.content) : f.content;
          recipe.format_version = "1.12";
          const shaped = recipe["minecraft:recipe_shaped"];
          const shapeless = recipe["minecraft:recipe_shapeless"];
          if (shaped) {
            shaped.description = { identifier: `${itemId}_recipe` };
            shaped.tags = ["crafting_table"];
            shaped.result = { item: itemId, count: 1 };
          }
          if (shapeless) {
            shapeless.description = { identifier: `${itemId}_recipe` };
            shapeless.tags = ["crafting_table"];
            shapeless.result = { item: itemId, count: 1 };
          }
          recipeFile = { path: `behavior_pack/recipes/${safeItemName}.json`, content: JSON.stringify(recipe, null, 2) };
          console.log("[RECIPE] Fixed. Result:", itemId, "Pattern:", JSON.stringify(shaped?.pattern), "Key:", JSON.stringify(shaped?.key));
        } catch (e) {
          console.error("[RECIPE ERROR]", e.message);
        }
      }
    }

    // Build script server-side for special effects (fire, poison, knockback, etc.)
    const allText = (itemDescription + " " + extraDetails).toLowerCase();
    const effects = [];

    let hasFire = false;
    if (/fire|burn|ignite|flame/i.test(allText)) {
      hasFire = true;
      const fireMatch = allText.match(/(\d+)\s*second/);
      const fireSeconds = fireMatch ? parseInt(fireMatch[1]) : 5;
      effects.push(`        target.setOnFire(${fireSeconds});`);
    }
    if (/poison/i.test(allText)) {
      const durMatch = allText.match(/poison.*?(\d+)\s*second/);
      const dur = durMatch ? parseInt(durMatch[1]) * 20 : 100;
      effects.push(`        target.addEffect("poison", ${dur}, { amplifier: 1 });`);
    }
    if (/wither/i.test(allText)) {
      const durMatch = allText.match(/wither.*?(\d+)\s*second/);
      const dur = durMatch ? parseInt(durMatch[1]) * 20 : 100;
      effects.push(`        target.addEffect("wither", ${dur}, { amplifier: 1 });`);
    }
    if (/slow|slowness/i.test(allText)) {
      const durMatch = allText.match(/slow.*?(\d+)\s*second/);
      const dur = durMatch ? parseInt(durMatch[1]) * 20 : 100;
      effects.push(`        target.addEffect("slowness", ${dur}, { amplifier: 2 });`);
    }
    if (/knockback|launch|fling/i.test(allText)) {
      effects.push(`        const dir = target.location;\n        const src = event.damagingEntity.location;\n        const dx = dir.x - src.x;\n        const dz = dir.z - src.z;\n        const len = Math.sqrt(dx*dx + dz*dz) || 1;\n        target.applyKnockback(dx/len, dz/len, 5, 0.5);`);
    }
    if (/heal|lifesteal|life steal/i.test(allText)) {
      effects.push(`        const source = event.damagingEntity;\n        if (source.getComponent("minecraft:health")) {\n          source.getComponent("minecraft:health").setCurrentValue(Math.min(source.getComponent("minecraft:health").currentValue + 4, source.getComponent("minecraft:health").effectiveMax));\n        }`);
    }
    if (/explod|explosion|boom/i.test(allText)) {
      effects.push(`        target.dimension.createExplosion(target.location, 3, { breaksBlocks: false, causesFire: false });`);
    }
    if (/lightning|thunder/i.test(allText)) {
      effects.push(`        target.dimension.spawnEntity("minecraft:lightning_bolt", target.location);`);
    }

    const hasScripts = effects.length > 0;
    let scriptFile = null;

    if (hasScripts) {
      let script = `import { world, ItemStack } from "@minecraft/server";

world.afterEvents.entityHitEntity.subscribe((event) => {
  const source = event.damagingEntity;
  const target = event.hitEntity;
  try {
    const equip = source.getComponent("minecraft:equippable");
    if (equip) {
      const mainhand = equip.getEquipment("Mainhand");
      if (mainhand && mainhand.typeId === "${itemId}") {
${effects.join("\n")}
      }
    }
  } catch (e) {}
});
`;

      // Add cooked meat drop handler for fire weapons
      if (hasFire) {
        script += `
const cookedDrops = {
  "minecraft:cow": "minecraft:cooked_beef",
  "minecraft:pig": "minecraft:cooked_porkchop",
  "minecraft:chicken": "minecraft:cooked_chicken",
  "minecraft:sheep": "minecraft:cooked_mutton",
  "minecraft:rabbit": "minecraft:cooked_rabbit",
  "minecraft:cod": "minecraft:cooked_cod",
  "minecraft:salmon": "minecraft:cooked_salmon",
};

world.afterEvents.entityDie.subscribe((event) => {
  try {
    const dead = event.deadEntity;
    const killer = event.damageSource?.damagingEntity;
    if (!killer || !dead) return;
    const equip = killer.getComponent("minecraft:equippable");
    if (!equip) return;
    const mainhand = equip.getEquipment("Mainhand");
    if (!mainhand || mainhand.typeId !== "${itemId}") return;
    const cooked = cookedDrops[dead.typeId];
    if (cooked) {
      dead.dimension.spawnItem(new ItemStack(cooked, 1), dead.location);
    }
  } catch (e) {}
});
`;
      }
      scriptFile = { path: "behavior_pack/scripts/main.js", content: script };

      bpManifest.modules.push({
        type: "script",
        uuid: randomUUID(),
        version: [1, 0, 0],
        entry: "scripts/main.js",
        language: "javascript",
      });
      bpManifest.dependencies = [
        { module_name: "@minecraft/server", version: "1.16.0" },
      ];
    }

    // Build final file list
    files = [
      { path: "behavior_pack/manifest.json", content: JSON.stringify(bpManifest, null, 2) },
      { path: `behavior_pack/items/${safeItemName}.json`, content: JSON.stringify(itemDef, null, 2) },
      { path: "resource_pack/manifest.json", content: JSON.stringify(rpManifest, null, 2) },
      { path: "resource_pack/textures/item_texture.json", content: JSON.stringify({
        resource_pack_name: fileName || itemName,
        texture_name: "atlas.items",
        texture_data: { [shortName]: { textures: `textures/items/${safeItemName}` } }
      }, null, 2) },
    ];

    // Add recipe if AI provided one
    if (recipeFile) files.push(recipeFile);

    // Add script if we built one
    if (scriptFile) files.push(scriptFile);

    // Add texture
    if (textureBase64) {
      files.push({ path: `resource_pack/textures/items/${safeItemName}.png`, content: textureBase64, isBinary: true });
    }

    // === DETAILED BUILD LOG ===
    console.log("\n========== MOD BUILD REPORT ==========");
    console.log("Item ID:", itemId);
    console.log("Display Name:", itemName);
    console.log("Namespace:", namespace);
    console.log("");
    console.log("[DAMAGE]", damage > 7 ? "CUSTOM: " + damage : "DEFAULT: " + damage, damage === 231 ? "(CAPPED AT MAX)" : "");
    console.log("[DURABILITY]", durability);
    console.log("[STACK SIZE]", isTool || isArmor ? "1 (weapon/tool)" : "64");
    console.log("[MENU CATEGORY]", menuCategory, menuGroup ? "/ " + menuGroup : "");
    console.log("");
    console.log("[TEXTURE]", textureBase64 ? "YES - PNG included (" + textureBase64.length + " base64 chars)" : "NO - texture generation failed");
    console.log("[TEXTURE SHORT NAME]", shortName);
    console.log("[TEXTURE FILE]", `resource_pack/textures/items/${safeItemName}.png`);
    console.log("[ITEM_TEXTURE.JSON]", "YES - maps", shortName, "->", `textures/items/${safeItemName}`);
    console.log("");
    console.log("[RECIPE]", recipeFile ? "YES - from AI" : "NO - AI didn't generate one");
    console.log("");
    console.log("[EFFECTS SCAN] Scanning:", JSON.stringify(allText.substring(0, 100)));
    console.log("  Fire:", /fire|burn|ignite|flame/i.test(allText) ? "DETECTED" : "not found");
    console.log("  Poison:", /poison/i.test(allText) ? "DETECTED" : "not found");
    console.log("  Wither:", /wither/i.test(allText) ? "DETECTED" : "not found");
    console.log("  Slowness:", /slow|slowness/i.test(allText) ? "DETECTED" : "not found");
    console.log("  Knockback:", /knockback|launch|fling/i.test(allText) ? "DETECTED" : "not found");
    console.log("  Lifesteal:", /heal|lifesteal|life steal/i.test(allText) ? "DETECTED" : "not found");
    console.log("  Explosion:", /explod|explosion|boom/i.test(allText) ? "DETECTED" : "not found");
    console.log("  Lightning:", /lightning|thunder/i.test(allText) ? "DETECTED" : "not found");
    console.log("[SCRIPT]", hasScripts ? "YES - " + effects.length + " effect(s)" : "NO - no effects detected");
    if (hasScripts) {
      console.log("[SCRIPT CONTENT]\n" + scriptFile.content);
    }
    console.log("");
    console.log("[FILES IN PACK]");
    files.forEach(f => console.log("  " + f.path + (f.isBinary ? " (binary)" : "")));
    console.log("======================================\n");

    res.write(`data: ${JSON.stringify({ type: "done", files })}\n\n`);
    res.end();
  } catch (err) {
    const msg = err.message || "Unknown error";
    if (!res.headersSent) {
      res.status(500).json({ error: msg });
    } else {
      res.write(`data: ${JSON.stringify({ type: "error", error: msg })}\n\n`);
      res.end();
    }
  }
});

function toBuffer(content, isBinary) {
  if (Buffer.isBuffer(content)) return content;
  if (isBinary) return Buffer.from(content, "base64");
  if (typeof content === "string") return Buffer.from(content, "utf-8");
  return Buffer.from(JSON.stringify(content, null, 2), "utf-8");
}

function randomUUID() {
  const h = () => Math.floor(Math.random() * 16).toString(16);
  const s = (n) => Array.from({ length: n }, h).join("");
  return `${s(8)}-${s(4)}-4${s(3)}-${(8 + Math.floor(Math.random() * 4)).toString(16)}${s(3)}-${s(12)}`;
}

function fixManifest(files) {
  const bpHeaderUuid = randomUUID();
  const rpHeaderUuid = randomUUID();

  return files.map(file => {
    if (!file.path.endsWith("manifest.json")) return file;

    let manifest;
    try {
      manifest = typeof file.content === "string" ? JSON.parse(file.content) : file.content;
    } catch {
      manifest = {};
    }

    const isBP = file.path.startsWith("behavior_pack/");
    const isRP = file.path.startsWith("resource_pack/");

    manifest.format_version = 2;

    if (!manifest.header || typeof manifest.header !== "object") {
      manifest.header = {};
    }
    manifest.header.name = manifest.header.name || (isBP ? "Behavior Pack" : "Resource Pack");
    manifest.header.description = manifest.header.description || "Generated by Minecraft Mod Generator";
    manifest.header.uuid = (typeof manifest.header.uuid === "string" && manifest.header.uuid.length === 36)
      ? manifest.header.uuid
      : (isBP ? bpHeaderUuid : rpHeaderUuid);
    manifest.header.version = Array.isArray(manifest.header.version)
      ? manifest.header.version.map(v => parseInt(v) || 0)
      : [1, 0, 0];
    manifest.header.min_engine_version = Array.isArray(manifest.header.min_engine_version)
      ? manifest.header.min_engine_version.map(v => parseInt(v) || 0)
      : [1, 20, 0];

    if (!Array.isArray(manifest.modules) || manifest.modules.length === 0) {
      manifest.modules = [{
        description: isBP ? "Behavior pack data" : "Resource pack resources",
        type: isBP ? "data" : "resources",
        uuid: randomUUID(),
        version: [1, 0, 0],
      }];
    } else {
      manifest.modules = manifest.modules.map(mod => ({
        ...mod,
        type: mod.type || (isBP ? "data" : "resources"),
        uuid: (typeof mod.uuid === "string" && mod.uuid.length === 36) ? mod.uuid : randomUUID(),
        version: Array.isArray(mod.version) ? mod.version.map(v => parseInt(v) || 0) : [1, 0, 0],
      }));
    }

    if (isRP) {
      const bpFile = files.find(f => f.path.startsWith("behavior_pack/") && f.path.endsWith("manifest.json"));
      let bpUuid = bpHeaderUuid;
      if (bpFile) {
        try {
          const bpManifest = typeof bpFile.content === "string" ? JSON.parse(bpFile.content) : bpFile.content;
          if (bpManifest.header && typeof bpManifest.header.uuid === "string" && bpManifest.header.uuid.length === 36) {
            bpUuid = bpManifest.header.uuid;
          }
        } catch {}
      }
      manifest.dependencies = [{ uuid: bpUuid, version: [1, 0, 0] }];
    }

    return { ...file, content: JSON.stringify(manifest, null, 2) };
  });
}

// Download files as zip / mcaddon / mcpack
app.post("/api/download", async (req, res) => {
  const { files, modName, edition } = req.body;
  if (!files || !Array.isArray(files)) {
    return res.status(400).json({ error: "No files provided" });
  }

  const safeName = (modName || "minecraft-mod").replace(/[^a-zA-Z0-9_-]/g, "-");
  const fixedFiles = edition === "bedrock" ? fixManifest(files) : files;

  if (edition === "bedrock") {
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}.mcaddon"`);

    const archive = archiver("zip", { zlib: { level: 6 } });
    archive.pipe(res);

    const bpFiles = fixedFiles.filter(f => f.path.startsWith("behavior_pack/"));
    const rpFiles = fixedFiles.filter(f => f.path.startsWith("resource_pack/"));

    if (bpFiles.length > 0) {
      const bpArchive = archiver("zip", { zlib: { level: 6 } });
      const bpChunks = [];
      bpArchive.on("data", chunk => bpChunks.push(chunk));
      await new Promise((resolve) => {
        bpArchive.on("end", resolve);
        for (const file of bpFiles) {
          bpArchive.append(toBuffer(file.content, file.isBinary), { name: file.path.replace(/^behavior_pack\//, "") });
        }
        bpArchive.finalize();
      });
      archive.append(Buffer.concat(bpChunks), { name: `${safeName}_BP.mcpack` });
    }

    if (rpFiles.length > 0) {
      const rpArchive = archiver("zip", { zlib: { level: 6 } });
      const rpChunks = [];
      rpArchive.on("data", chunk => rpChunks.push(chunk));
      await new Promise((resolve) => {
        rpArchive.on("end", resolve);
        for (const file of rpFiles) {
          rpArchive.append(toBuffer(file.content, file.isBinary), { name: file.path.replace(/^resource_pack\//, "") });
        }
        rpArchive.finalize();
      });
      archive.append(Buffer.concat(rpChunks), { name: `${safeName}_RP.mcpack` });
    }

    await archive.finalize();
  } else {
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}.zip"`);

    const archive = archiver("zip", { zlib: { level: 6 } });
    archive.pipe(res);

    for (const file of fixedFiles) {
      archive.append(toBuffer(file.content, file.isBinary), { name: file.path });
    }

    await archive.finalize();
  }
});

app.listen(PORT, () => {
  console.log(`Minecraft Mod Generator running at http://localhost:${PORT}`);
});
