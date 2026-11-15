import { Router, type IRouter } from "express";
import healthRouter from "./health";
import transitRouter from "./transit";
import municipalRouter from "./municipal";
import stopsRouter from "./stops";

const router: IRouter = Router();

router.use(healthRouter);
router.use(transitRouter);
router.use(municipalRouter);
router.use(stopsRouter);

export default router;
