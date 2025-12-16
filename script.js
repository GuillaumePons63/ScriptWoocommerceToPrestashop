require("dotenv/config");
const { readFile } = require("node:fs/promises");
const pLimit = require("p-limit");
const { XMLParser } = require("fast-xml-parser");
const { fetch, FormData, File } = require("undici");

const PS_BASE_URL = (process.env.PS_BASE_URL || "").replace(/\/$/, "");
const PS_API_KEY = process.env.PS_API_KEY || "";
const PS_LANG_ID = Number(process.env.PS_LANG_ID || 1);
const PS_SHOP_ID = Number(process.env.PS_SHOP_ID || 1);
const PS_HOME_CATEGORY_ID = Number(process.env.PS_HOME_CATEGORY_ID || 2);
const PS_TAX_RULE_GROUP_ID = Number(process.env.PS_TAX_RULE_GROUP_ID || 1);

const WXR_PATH = process.env.xml_PATH || "./export.xml";
const CONCURRENCY = Number(process.env.CONCURRENCY || 3);

if (!PS_BASE_URL || !PS_API_KEY) throw new Error("PS_BASE_URL / PS_API_KEY manquants");

const parser = new XMLParser({
  removeNSPrefix: true,
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
});

const authHeader = () => "Basic " + Buffer.from(`${PS_API_KEY}:`).toString("base64");

const toArray = (x) => (x ? (Array.isArray(x) ? x : [x]) : []);
const txt = (v) => {
  if (v == null) return "";
  if (typeof v === "string" || typeof v === "number") return String(v);
  return String(v["#text"] ?? v["#cdata"] ?? v["__cdata"] ?? "");
};

const slugify = (s) =>
  (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 128) || "produit";

const psRequest = async (path, { method = "GET", headers = {}, body } = {}) => {
  const url = `${PS_BASE_URL}${path}`;
  const res = await fetch(url, {
    method,
    headers: { Authorization: authHeader(), ...headers },
    body,
  });
  const buf = Buffer.from(await res.arrayBuffer());
  return { res, buf, url };
};

const parsePsXml = (buf) => parser.parse(buf.toString("utf-8"));

const buildProductXml = ({ productType, name, reference, price, description, shortDescription, metaDescription, categoriesIds }) => {
  const link = slugify(name);
  const catsXml = (categoriesIds?.length ? categoriesIds : [PS_HOME_CATEGORY_ID])
    .map((id) => `<category><id><![CDATA[${id}]]></id></category>`)
    .join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<prestashop xmlns:xlink="http://www.w3.org/1999/xlink">
  <product>
    <id_shop_default><![CDATA[${PS_SHOP_ID}]]></id_shop_default>
    <id_category_default><![CDATA[${categoriesIds?.[0] ?? PS_HOME_CATEGORY_ID}]]></id_category_default>
    <id_tax_rules_group><![CDATA[${PS_TAX_RULE_GROUP_ID}]]></id_tax_rules_group>
    <product_type><![CDATA[${productType}]]></product_type>
    <type><![CDATA[1]]></type>
    <active><![CDATA[1]]></active>
    <reference><![CDATA[${reference}]]></reference>
    <price><![CDATA[${price}]]></price>

    <meta_description>
      <language id="${PS_LANG_ID}"><![CDATA[${metaDescription || ""}]]></language>
    </meta_description>

    <name>
      <language id="${PS_LANG_ID}"><![CDATA[${name}]]></language>
    </name>
    <link_rewrite>
      <language id="${PS_LANG_ID}"><![CDATA[${link}]]></language>
    </link_rewrite>
    <description>
      <language id="${PS_LANG_ID}"><![CDATA[${description || ""}]]></language>
    </description>
    <description_short>
      <language id="${PS_LANG_ID}"><![CDATA[${shortDescription || ""}]]></language>
    </description_short>

    <associations>
      <categories>
        ${catsXml}
      </categories>
    </associations>
  </product>
</prestashop>`;
};

async function createProduct(productXml) {
  const { res, buf, url } = await psRequest("/api/products", {
    method: "POST",
    headers: { "Content-Type": "application/xml" },
    body: productXml,
  });
  if (!res.ok) throw new Error(`Create product KO (${res.status}) ${url}\n${buf}`);
  const data = parsePsXml(buf);
  const id = Number(txt(data?.prestashop?.product?.id));
  if (!id) throw new Error("ID produit introuvable dans réponse PrestaShop");
  return id;
}

async function createOptionGroup(name) {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<prestashop xmlns:xlink="http://www.w3.org/1999/xlink">
  <product_option>
    <is_color_group><![CDATA[0]]></is_color_group>
    <group_type><![CDATA[select]]></group_type>
    <name><language id="${PS_LANG_ID}"><![CDATA[${name}]]></language></name>
    <public_name><language id="${PS_LANG_ID}"><![CDATA[${name}]]></language></public_name>
  </product_option>
</prestashop>`;

  const { res, buf } = await psRequest("/api/product_options", {
    method: "POST",
    headers: { "Content-Type": "application/xml" },
    body: xml,
  });
  if (!res.ok) throw new Error(`Create product_option KO (${res.status})\n${buf}`);
  const data = parsePsXml(buf);
  return Number(txt(data?.prestashop?.product_option?.id));
}

async function createOptionValue(groupId, valueName) {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<prestashop xmlns:xlink="http://www.w3.org/1999/xlink">
  <product_option_value>
    <id_attribute_group><![CDATA[${groupId}]]></id_attribute_group>
    <name><language id="${PS_LANG_ID}"><![CDATA[${valueName}]]></language></name>
  </product_option_value>
</prestashop>`;

  const { res, buf } = await psRequest("/api/product_option_values", {
    method: "POST",
    headers: { "Content-Type": "application/xml" },
    body: xml,
  });
  if (!res.ok) throw new Error(`Create product_option_value KO (${res.status})\n${buf}`);
  const data = parsePsXml(buf);
  return Number(txt(data?.prestashop?.product_option_value?.id));
}

async function createCombination(productId, optionValueId, reference, priceImpact = "0.000000") {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<prestashop xmlns:xlink="http://www.w3.org/1999/xlink">
  <combination>
    <id_product><![CDATA[${productId}]]></id_product>
    <reference><![CDATA[${reference}]]></reference>
    <price><![CDATA[${priceImpact}]]></price>
    <associations>
      <product_option_values nodeType="product_option_value" api="product_option_values">
        <product_option_value>
          <id><![CDATA[${optionValueId}]]></id>
        </product_option_value>
      </product_option_values>
    </associations>
  </combination>
</prestashop>`;

  const { res, buf } = await psRequest("/api/combinations", {
    method: "POST",
    headers: { "Content-Type": "application/xml" },
    body: xml,
  });
  if (!res.ok) throw new Error(`Create combination KO (${res.status})\n${buf}`);
  const data = parsePsXml(buf);
  return Number(txt(data?.prestashop?.combination?.id));
}

async function uploadProductImage(productId, imageBuffer, filename, mime = "image/jpeg") {
  const form = new FormData();
  form.append("image", new Blob([imageBuffer], { type: mime }), filename);

  const { res, buf } = await psRequest(`/api/images/products/${productId}`, {
    method: "POST",
    body: form,
  });

  if (!res.ok) {
    throw new Error(`Upload image KO (${res.status})\n${buf.toString("utf-8")}`);
  }
}

async function download(url) {
  url.replace("/wp-content/uplloads/", "/wp-content/uploads/");
  const res = await fetch(url);
  if (!res.ok) throw new Error(`DL ${url} => ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const ct = res.headers.get("content-type") || "image/jpeg";
  return { buf, ct };
}

function parseWxrProductsAndAttachments(wxr) {
  const items = toArray(wxr?.rss?.channel?.item);

  // Map attachments: wp:post_type=attachment => wp:post_id => wp:attachment_url (ou guid)
  const attachments = new Map();
  for (const it of items) {
    if (txt(it?.post_type) !== "attachment") continue;
    const id = txt(it?.post_id);
    const url = txt(it?.attachment_url) || txt(it?.guid);
    if (id && url) attachments.set(id, url);
  }

  const products = [];
  for (const it of items) {
    if (txt(it?.post_type) !== "product") continue;

    const title = txt(it?.title).trim();
    const description = txt(it?.encoded).trim(); // content:encoded => encoded
    const shortDescription = txt(it?.excerpt?.encoded).trim();
    const metaDescription = (() => {
      const metas = toArray(it?.postmeta);
      for (const m of metas) {
        if (txt(m?.meta_key) === "_yoast_wpseo_metadesc") return txt(m?.meta_value);
      }
      return "";
    })();

    // postmeta => object (attention: doublons dans ton export, on garde le dernier)
    const meta = {};
    for (const m of toArray(it?.postmeta)) {
      const k = txt(m?.meta_key);
      const v = txt(m?.meta_value);
      if (k) meta[k] = v;
    }

    const sku = (meta["_sku"] || "").trim() || `WP-${txt(it?.post_id)}`;
    const price = (meta["_price"] || meta["_regular_price"] || "0").trim();

    // catégories & tailles dans <category ...>
    const cats = toArray(it?.category).map((c) => ({
      domain: c?.["@_domain"],
      nicename: c?.["@_nicename"],
      value: txt(c),
    }));

    const isVariable = cats.some((c) => c.domain === "product_type" && c.value === "variable");
    const sizes = cats
      .filter((c) => c.domain === "pa_taille")
      .map((c) => c.value)
      .filter(Boolean);

    const productCats = cats.filter((c) => c.domain === "product_cat").map((c) => c.value);

    const thumbId = (meta["_thumbnail_id"] || "").trim();
    const galleryIds = (meta["_product_image_gallery"] || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const imageUrls = [];
    if (thumbId && attachments.has(thumbId)) imageUrls.push(attachments.get(thumbId));
    for (const gid of galleryIds) {
      const u = attachments.get(gid);
      if (u && !imageUrls.includes(u)) imageUrls.push(u);
    }

    products.push({
      title,
      sku,
      price,
      description,
      shortDescription,
      metaDescription,
      isVariable,
      sizes,
      productCats,
      imageUrls,
    });
  }

  return { products };
}

async function main() {
  const xml = await readFile(WXR_PATH, "utf-8");
  const wxr = parser.parse(xml);
  const { products } = parseWxrProductsAndAttachments(wxr);

  console.log(`Produits trouvés: ${products.length}`);

  // Option group unique pour "Taille" (simple version: on le crée une fois)
  let tailleGroupId = null;

  const limit = pLimit(CONCURRENCY);

  const results = await Promise.allSettled(
    products.map((p) =>
      limit(async () => {
        const productType = p.isVariable ? "combinations" : "standard";

        // Ici: on met tout dans Home (tu peux enrichir plus tard avec vraie création de catégories)
        const productXml = buildProductXml({
          productType,
          name: p.title,
          reference: p.sku,
          price: p.price,
          description: p.description,
          shortDescription: p.shortDescription,
          metaDescription: p.metaDescription,
          categoriesIds: [PS_HOME_CATEGORY_ID],
        });

        const productId = await createProduct(productXml);
        console.log(`✅ ${p.sku} -> productId=${productId} (${productType})`);

        // Images produit
        for (let i = 0; i < p.imageUrls.length; i++) {
          const u = p.imageUrls[i];
          try {
            const { buf, ct } = await download(u);
            const ext = ct.includes("png") ? "png" : "jpg";
            await uploadProductImage(productId, buf, `${p.sku}-${i + 1}.${ext}`, ct);
            console.log(`  🖼️ image ${i + 1}/${p.imageUrls.length} OK`);
          } catch (e) {
            console.warn(`  ⚠️ image KO: ${u} (${e.message})`);
          }
        }

        // Déclinaisons "Taille"
        if (p.isVariable && p.sizes.length) {
          if (!tailleGroupId) {
            tailleGroupId = await createOptionGroup("Taille");
            console.log(`  ✅ Option group "Taille" id=${tailleGroupId}`);
          }

          // crée toutes les valeurs + combinaisons
          for (const size of p.sizes) {
            const valId = await createOptionValue(tailleGroupId, size);
            const combRef = `${p.sku}-${size}`;
            const combId = await createCombination(productId, valId, combRef, "0.000000");
            console.log(`  ✅ comb ${size} -> combinationId=${combId}`);
          }
        }
      })
    )
  );

  const ok = results.filter((r) => r.status === "fulfilled").length;
  const ko = results.length - ok;
  console.log(`\nTerminé. OK=${ok} / KO=${ko}`);
  results.forEach((r) => {
    if (r.status === "rejected") console.error("❌", r.reason?.message || r.reason);
  });
}

main().catch((e) => {
  console.error("❌ Fatal:", e);
  process.exit(1);
});