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

import * as authService from "../services/authService.js";
import { str } from "../utils/validate.js";

// Only same-site paths: "//host" and "/\host" are treated as protocol-relative by browsers.
export const safeNext = (value) => (typeof value === "string" && value.startsWith("/") && !/^\/[/\\]/.test(value) && !value.includes("\\") ? value : "/dashboard");

export const loginPage = (req, res) => {
  if (req.user) return res.redirect("/dashboard");
  res.render("auth/login", { layout: "layouts/auth", title: "Sign in", next: req.query.next || "" });
};

export const loginUser = async (req, res) => {
  const username = str(req.body.username, "Username", { required: true, max: 50 });
  const password = String(req.body.password || "");
  const next = safeNext(req.body.next);
  try {
    await authService.login(req, username, password);
    res.redirect(next);
  } catch (err) {
    if (!err.status || err.status >= 500) throw err;
    res.status(err.status).render("auth/login", { layout: "layouts/auth", title: "Sign in", error: err.message, username, next });
  }
};

export const logoutUser = async (req, res) => {
  await authService.logout(req);
  res.clearCookie("hotelpos.sid");
  res.redirect("/login");
};

export const forgotPasswordPage = (req, res) =>
  res.render("auth/forgot-password", { layout: "layouts/auth", title: "Forgot password" });

export const changePasswordPage = (req, res) =>
  res.render("auth/change-password", { title: "Change password", breadcrumbs: [{ label: "Change password" }] });

export const changePassword = async (req, res) => {
  await authService.changePassword(req, req.body.currentPassword, req.body.newPassword, req.body.confirmPassword);
  req.flash("success_msg", "Your password has been changed.");
  res.redirect("/dashboard");
};
