import source from "./properties.json";
import type { DataState, Property } from "./domain";
export function seed(): DataState {
  const capacities = [90, 70, 110, 80, 50, 100];
  const properties = source.map((p, i) => ({
    ...p,
    name: p.name.replace("Aangan", "Sehrawat"),
    img: "/images/" + p.img.split("/").pop(),
    beds: capacities[i],
    occupied: [82, 64, 94, 67, 46, 87][i],
  })) as Property[];
  const names = [
    "Rohit Kulkarni",
    "Priya Sharma",
    "Arjun Mehta",
    "Neha Kapoor",
    "Aditya Rao",
    "Ananya Singh",
    "Karan Malhotra",
    "Ishita Gupta",
    "Vikram Sethi",
    "Riya Jain",
    "Aman Verma",
    "Meera Nair",
  ];
  const residents = names.map((name, i) => ({
    id: `R${1001 + i}`,
    name,
    email: `resident${i + 1}@example.com`,
    phone: `90000000${String(i + 1).padStart(2, "0")}`,
    propertyId: properties[i % 6].id,
    room: `${201 + Math.floor(i / 2)}${i % 2 ? "B" : "A"}`,
    rent: properties[i % 6].rooms.double.price,
    status: "Active",
    joined: "2026-10-01",
    ...(i > 7 ? { corporateId: "C001" } : {}),
  }));
  const period = new Date().toISOString().slice(0, 7);
  const due = period + "-05";
  return {
    beds: properties.flatMap((p) =>
      Array.from({ length: p.beds }, (_, i) => ({
        id: p.id + "-B" + (i + 1),
        propertyId: p.id,
        room: String(101 + Math.floor(i / 2)) + (i % 2 ? "B" : "A"),
        type: "double",
        status: i < p.occupied ? "Occupied" : "Available",
      })),
    ),
    properties,
    residents,
    invoices: residents.map((r, i) => ({
      id: `INV-${1001 + i}`,
      residentId: r.id,
      corporateId: r.corporateId,
      period,
      due,
      amount: r.rent + 600,
      paid: i % 3 ? r.rent + 600 : 0,
      status: i % 3 ? "Paid" : "Due",
      description: "Monthly rent + electricity",
    })),
    tickets: [
      {
        id: "T001",
        residentId: "R1001",
        subject: "Study light needs replacement",
        category: "Electrical",
        description: "The light above my desk flickers in the evening.",
        status: "Open",
        priority: "Normal",
        created: new Date().toISOString(),
        assignee: "Unassigned",
      },
      {
        id: "T002",
        residentId: "R1002",
        subject: "Water purifier service",
        category: "Housekeeping",
        description: "The drinking water filter needs servicing.",
        status: "In progress",
        priority: "High",
        created: new Date().toISOString(),
        assignee: "Property team",
      },
    ],
    leads: [
      {
        id: "L001",
        name: "Dev Patel",
        phone: "9000000099",
        email: "dev@example.com",
        propertyId: "cyber-nest",
        date: new Date().toISOString().slice(0, 10),
        status: "New",
        notes: "Looking for double sharing near Cyber Hub.",
        kind: "Visit",
      },
    ],
    agreements: [
      {
        id: "A001",
        residentId: "R1001",
        title: "Residential stay agreement",
        status: "Awaiting signature",
        created: new Date().toISOString(),
      },
      {
        id: "A002",
        residentId: "R1002",
        title: "Residential stay agreement",
        status: "Signed",
        created: new Date().toISOString(),
      },
    ],
    campaigns: [
      {
        id: "CAM001",
        name: "November move-in offer",
        template: "move_in_offer",
        audience: "Opted-in leads",
        scheduled: "",
        status: "Draft",
        recipients: 48,
        delivered: 0,
      },
    ],
    conversations: [
      {
        id: "CH001",
        name: "Rohit Kulkarni",
        residentId: "R1001",
        mode: "Human",
        assignee: "Owner",
        lastInbound: new Date().toISOString(),
        messages: [
          {
            id: "M001",
            body: "Hi, can I get help with my rent receipt?",
            sender: "customer",
            time: new Date().toISOString(),
            status: "Received",
          },
          {
            id: "M002",
            body: "Of course. You can find your receipts in Rent & bills in your portal.",
            sender: "staff",
            time: new Date().toISOString(),
            status: "Delivered",
          },
        ],
      },
      {
        id: "CH002",
        name: "Priya Sharma",
        residentId: "R1002",
        mode: "Bot",
        assignee: "Unassigned",
        lastInbound: new Date().toISOString(),
        messages: [
          {
            id: "M003",
            body: "What is on the dinner menu today?",
            sender: "customer",
            time: new Date().toISOString(),
            status: "Received",
          },
        ],
      },
    ],
    expenses: [
      {
        id: "E001",
        category: "Food",
        description: "Monthly grocery supplies",
        amount: 82000,
        date: period + "-01",
      },
      {
        id: "E002",
        category: "Utilities",
        description: "Electricity and internet",
        amount: 28000,
        date: period + "-02",
      },
      {
        id: "E003",
        category: "Staff",
        description: "Property team salaries",
        amount: 64000,
        date: period + "-03",
      },
    ],
    allocations: residents
      .filter((r) => r.corporateId)
      .map((r, i) => ({
        id: "AL" + i,
        corporateId: "C001",
        employee: r.name,
        propertyId: r.propertyId,
        room: r.room,
        start: "2026-10-01",
        end: "2027-03-31",
        status: "Active",
      })),
    requests: [],
    payments: [],
    settings: {
      businessName: "Sehrawat PG",
      rentDay: 5,
      reminders: true,
      bot: true,
      marketingCap: 1000,
      utilityCap: 1000,
    },
  };
}
