import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@ltds/ui/styles.css";
import "./styles.css";
import { DeliveryApp } from "./DeliveryApp";

createRoot(document.getElementById("root")!).render(<StrictMode><DeliveryApp /></StrictMode>);
