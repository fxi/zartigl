import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";
import { StoryApp } from "./StoryApp";

const app = new StoryApp();
void app.start();
(window as Window & { story?: StoryApp }).story = app;

