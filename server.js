require("dotenv").config();

const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

// =========================
// FOLDERS / FILES
// =========================

const DATA_FOLDER = path.join(__dirname, "data");
const ORDERS_FILE = path.join(DATA_FOLDER, "orders.json");

if (!fs.existsSync(DATA_FOLDER)) {
    fs.mkdirSync(DATA_FOLDER, { recursive: true });
}

if (!fs.existsSync(ORDERS_FILE)) {
    fs.writeFileSync(ORDERS_FILE, "[]", "utf8");
}

// =========================
// MIDDLEWARE
// =========================

app.use(express.json({ limit: "100kb" }));

app.use(express.static(path.join(__dirname, "public")));

// =========================
// ORDER FUNCTIONS
// =========================

function getOrders() {
    try {
        return JSON.parse(
            fs.readFileSync(ORDERS_FILE, "utf8")
        );
    } catch (error) {
        console.error("Could not read orders:", error);
        return [];
    }
}

function saveOrders(orders) {
    fs.writeFileSync(
        ORDERS_FILE,
        JSON.stringify(orders, null, 2),
        "utf8"
    );
}

function createOrderID() {
    return (
        "RZ-" +
        Date.now() +
        "-" +
        crypto.randomBytes(2).toString("hex").toUpperCase()
    );
}

function cleanPhone(phone) {
    return String(phone || "").replace(/[^\d]/g, "");
}

// =========================
// WHATSAPP MESSAGE
// =========================

function createWhatsAppMessage(order) {

    let message =
        "*NEW ORDER - RAMZAN ZAFAR RESTAURANT*\n\n";

    message += "*Order ID:* " + order.id + "\n";
    message += "*Customer:* " + order.customer.name + "\n";
    message += "*Phone:* " + order.customer.phone + "\n";
    message += "*Address:* " + order.customer.address + "\n\n";

    message += "*ORDER DETAILS*\n";
    message += "-------------------------\n";

    order.items.forEach(function (item) {

        const itemTotal =
            Number(item.price) * Number(item.quantity);

        message +=
            item.name +
            " x " +
            item.quantity +
            " = Rs. " +
            itemTotal +
            "\n";
    });

    message += "-------------------------\n";

    message +=
        "*TOTAL: Rs. " +
        order.total +
        "*\n\n";

    message += "*Status:* Pending";

    return message;
}

// =========================
// WHATSAPP API
// =========================

async function sendWhatsAppMessage(message) {

    const phoneNumberID =
        process.env.WHATSAPP_PHONE_NUMBER_ID;

    const accessToken =
        process.env.WHATSAPP_ACCESS_TOKEN;

    const apiVersion =
        process.env.WHATSAPP_API_VERSION || "v21.0";

    const restaurantNumber =
        cleanPhone(
            process.env.RESTAURANT_NOTIFICATION_NUMBER
        );

    if (
        !phoneNumberID ||
        !accessToken ||
        !restaurantNumber
    ) {
        throw new Error(
            "WhatsApp API configuration is incomplete."
        );
    }

    const url =
        "https://graph.facebook.com/" +
        apiVersion +
        "/" +
        phoneNumberID +
        "/messages";

    const response = await fetch(url, {

        method: "POST",

        headers: {
            "Authorization":
                "Bearer " + accessToken,

            "Content-Type":
                "application/json"
        },

        body: JSON.stringify({

            messaging_product: "whatsapp",

            recipient_type: "individual",

            to: restaurantNumber,

            type: "text",

            text: {
                preview_url: false,
                body: message
            }
        })
    });

    const data = await response.json();

    if (!response.ok) {

        console.error(
            "WhatsApp API Error:",
            data
        );

        throw new Error(
            data?.error?.message ||
            "WhatsApp API request failed."
        );
    }

    return data;
}

// =========================
// CREATE ORDER
// =========================

app.post("/api/orders", async function (req, res) {

    try {

        const body = req.body;

        if (!body.customer) {
            return res.status(400).json({
                success: false,
                message: "Customer information is required."
            });
        }

        if (
            !body.customer.name ||
            !body.customer.phone ||
            !body.customer.address
        ) {
            return res.status(400).json({
                success: false,
                message:
                    "Customer name, phone and address are required."
            });
        }

        if (
            !Array.isArray(body.items) ||
            body.items.length === 0
        ) {
            return res.status(400).json({
                success: false,
                message: "Your cart is empty."
            });
        }

        const items = body.items.map(function (item) {

            return {

                id: item.id || "",

                name: String(item.name || "Food Item"),

                price: Number(item.price) || 0,

                quantity:
                    Math.max(
                        1,
                        Number(item.quantity) || 1
                    )
            };
        });

        let total = 0;

        items.forEach(function (item) {

            total +=
                item.price *
                item.quantity;
        });

        const order = {

            id: createOrderID(),

            customer: {

                name:
                    String(
                        body.customer.name
                    ).trim(),

                phone:
                    String(
                        body.customer.phone
                    ).trim(),

                address:
                    String(
                        body.customer.address
                    ).trim()
            },

            items: items,

            total: total,

            status: "pending",

            whatsappSent: false,

            createdAt:
                new Date().toISOString()
        };

        // Save order
        const orders = getOrders();

        orders.push(order);

        saveOrders(orders);

        // Send WhatsApp
        try {

            const message =
                createWhatsAppMessage(order);

            await sendWhatsAppMessage(message);

            order.whatsappSent = true;

            const updatedOrders = getOrders();

            const index =
                updatedOrders.findIndex(
                    function (savedOrder) {
                        return savedOrder.id === order.id;
                    }
                );

            if (index !== -1) {

                updatedOrders[index] = order;

                saveOrders(updatedOrders);
            }

        } catch (whatsappError) {

            console.error(
                "WhatsApp notification failed:",
                whatsappError
            );
        }

        return res.status(201).json({

            success: true,

            message:
                "Order received successfully.",

            order: order
        });

    } catch (error) {

        console.error(
            "ORDER ERROR:",
            error
        );

        return res.status(500).json({

            success: false,

            message:
                "Unable to process your order."
        });
    }
});

// =========================
// ADMIN AUTHENTICATION
// =========================

function adminAuthentication(req, res, next) {

    const expectedKey =
        process.env.ADMIN_API_KEY;

    if (!expectedKey) {

        return res.status(500).json({

            success: false,

            message:
                "ADMIN_API_KEY is not configured."
        });
    }

    const authorization =
        req.headers.authorization || "";

    const token =
        authorization.startsWith("Bearer ")
            ? authorization.substring(7)
            : "";

    if (token !== expectedKey) {

        return res.status(401).json({

            success: false,

            message: "Unauthorized."
        });
    }

    next();
}

// =========================
// GET ORDERS
// =========================

app.get(
    "/api/orders",
    adminAuthentication,
    function (req, res) {

        const orders = getOrders();

        res.json({
            success: true,
            orders: orders
        });
    }
);

// =========================
// UPDATE ORDER STATUS
// =========================

app.patch(
    "/api/orders/:id/status",
    adminAuthentication,
    function (req, res) {

        const orderID =
            req.params.id;

        const newStatus =
            req.body.status;

        const allowedStatuses = [

            "pending",

            "accepted",

            "declined",

            "preparing",

            "out_for_delivery",

            "completed"
        ];

        if (
            !allowedStatuses.includes(
                newStatus
            )
        ) {

            return res.status(400).json({

                success: false,

                message:
                    "Invalid order status."
            });
        }

        const orders =
            getOrders();

        const order =
            orders.find(
                function (item) {
                    return item.id === orderID;
                }
            );

        if (!order) {

            return res.status(404).json({

                success: false,

                message:
                    "Order not found."
            });
        }

        order.status =
            newStatus;

        order.updatedAt =
            new Date().toISOString();

        saveOrders(orders);

        res.json({

            success: true,

            order: order
        });
    }
);

// =========================
// ADMIN PAGE
// =========================

app.get(
    "/admin",
    function (req, res) {

        res.sendFile(
            path.join(
                __dirname,
                "public",
                "admin.html"
            )
        );
    }
);

// =========================
// HEALTH CHECK
// =========================

app.get(
    "/api/health",
    function (req, res) {

        res.json({

            online: true,

            restaurant:
                "Ramzan Zafar Restaurant"
        });
    }
);

// =========================
// START SERVER
// =========================

app.listen(
    PORT,
    function () {

        console.log(
            "======================================"
        );

        console.log(
            "Ramzan Zafar Restaurant server started"
        );

        console.log(
            "Server: http://localhost:" +
            PORT
        );

        console.log(
            "Admin:  http://localhost:" +
            PORT +
            "/admin"
        );

        console.log(
            "======================================"
        );
    }
);