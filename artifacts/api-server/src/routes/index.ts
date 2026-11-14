import { Router, type IRouter } from "express";
import healthRouter from "./health";
import transitRouter from "./transit";
import municipalRouter from "./municipal";

const router: IRouter = Router();

router.use(healthRouter);
router.use(transitRouter);
router.use(municipalRouter);

export default router;
