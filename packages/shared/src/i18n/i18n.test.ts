import { describe, expect, test } from "bun:test";
import { catalogs, translate, translateText } from "./index";

describe("i18n", () => {
  test("a key with placeholders matches the text already filled in by the server", () => {
    expect(translateText("es", "Deploy shop.example.com")).toBe("Desplegar shop.example.com");
    expect(translateText("es", "Roll back shop.example.com to release 12")).toBe("Volver a la versión 12 de shop.example.com");
  });

  test("unknown text is returned as is, and English is never changed", () => {
    expect(translateText("es", "something the catalog does not know")).toBe("something the catalog does not know");
    expect(translateText("en", "Deploy shop.example.com")).toBe("Deploy shop.example.com");
  });

  test("UI texts are not used to translate server messages", () => {
    // "{{used}} of {{limit}}" belongs to the web UI: an unknown message containing " of " must not change.
    expect(translateText("es", "a of b")).toBe("a of b");
  });

  test("translate interpolates the values", () => {
    expect(translate("es", "Delete {{name}}?", { name: "shop" })).toBe("¿Eliminar shop?");
  });

  test("Spanish entries keep the same placeholders as their English keys", () => {
    const names = (text: string) => [...text.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((match) => match[1]).sort();
    for (const [key, value] of Object.entries(catalogs.es)) {
      expect({ key, names: names(value) }).toEqual({ key, names: names(key.replace(/_(one|other)$/, "")) });
    }
  });
});
