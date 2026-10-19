import "@fontsource-variable/inter-tight";
import "./site.css";
import { mountSite } from "./site";

// Entry of the standalone page. A CMS page mounts the same way: one element,
// with `data-content` pointing to the folder that holds home.json.
const root = document.getElementById("site");
if (root) {
  const params = new URLSearchParams(location.search);
  const contentUrl = new URL(
    root.dataset.content ?? `${import.meta.env.BASE_URL}content/`,
    location.href,
  );
  mountSite(root, {
    contentUrl,
    locale: params.get("lang"),
    forceFallback: params.has("fallback"),
  }).catch((error: unknown) => {
    console.error(error);
    root.textContent = String(error);
  });
}
