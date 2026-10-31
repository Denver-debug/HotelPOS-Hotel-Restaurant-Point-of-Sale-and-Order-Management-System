export const dashboardPage = async (req, res) => {
  res.render("dashboard/index", { title: "Dashboard" });
};
