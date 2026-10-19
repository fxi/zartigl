import "@fontsource-variable/inter-tight";
import "./style.css";
import { StoryProjversorApp } from "./StoryProjversorApp";

const root = document.getElementById("app");
if (root) {
  try {
    new StoryProjversorApp(root).start();
  } catch (error) {
    console.error(error);
    root.querySelector('[data-ref="status"]')!.textContent = String(error);
  }
}
