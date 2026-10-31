/*
    MIT License
    
    Copyright (c) 2025 Christian I. Cabrera || XianFire Framework
    Mindoro State University - Philippines

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE.
    */

import { Outlet } from "../models/index.js";

const OUTLET_ICONS = { RESTAURANT: "utensils", BAR: "cocktail", ROOM_SERVICE: "cloche", MINIBAR: "box", SPA: "leaf", OTHER: "building" };

// Public landing page; signed-in staff go straight to their dashboard.
export const homePage = async (req, res) => {
  if (req.user) return res.redirect("/dashboard");
  const outlets = await Outlet.findAll({ where: { status: "ACTIVE" }, attributes: ["name", "outletType", "location"], order: [["name", "ASC"]] });
  res.render("landing", {
    layout: "layouts/landing",
    title: "Welcome",
    outlets: outlets.map((o) => ({ ...o.get({ plain: true }), icon: OUTLET_ICONS[o.outletType] || "building" })),
    year: new Date().getFullYear(),
  });
};
