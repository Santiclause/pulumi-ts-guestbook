// Copyright 2016-2025, Pulumi Corporation.  All rights reserved.

import * as kubernetes from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import * as serviceMonitor from "@pulumi/service-monitor";

const config = new pulumi.Config();
const ingressControllerNamespace = "nginx-ingress";
const namespace = config.get("namespace");
export const adminPassword = "fizzbuzz123";

const ingressNs = new kubernetes.core.v1.Namespace("ingressns", {metadata: {
    name: ingressControllerNamespace,
}});

// Use Helm to install the Nginx ingress controller
const ingressController = new kubernetes.helm.v3.Release("ingresscontroller", {
    chart: "nginx-ingress",
    namespace: ingressNs.metadata.name,
    repositoryOpts: {
        repo: "https://helm.nginx.com/stable",
    },
    skipCrds: true,
    skipAwait: true,
    values: {
        controller: {
            allowEmptyIngressHost: true,
            enableCustomResources: false,
            appprotect: {
                enable: false,
            },
            appprotectdos: {
                enable: false,
            },
        },
    },
    version: "2.8.0",
}, {
    deleteBeforeReplace: true,
});

const redisLeader = new kubernetes.apps.v1.Deployment("redis-leader", {
    spec: {
        selector: { matchLabels: {app: "redis-leader"} },
        replicas: 1,
        template: {
            metadata: { labels: {app: "redis-leader"} },
            spec: {
                containers: [{
                    name: "redis",
                    image: "redis",
                    resources: { requests: { cpu: "100m", memory: "100Mi" } },
                    env: [{ name: "GET_HOSTS_FROM", value: "dns" }],
                    ports: [{
                        containerPort: 6379,
                        name: "redis",
                    }],
                }, {
                    name: "redis-exporter",
                    image: "bitnami/redis-exporter",
                    resources: { requests: { cpu: "100m", memory: "100Mi" } },
                    ports: [{
                        containerPort: 9121,
                        name: "prom",
                    }],
                }],
            },
        },
    },
});

const redisLeaderSvc = new kubernetes.core.v1.Service("redis-leader", {
    metadata: {
        name: "redis-leader",
        labels: {app: "guestbook"},
    },
    spec: {
        ports: [
            {port: 6379, name: "redis"},
            {port: 9121, name: "prom"},
        ],
        selector: redisLeader.spec.template.metadata.labels,
        type: "ClusterIP",
    },
});


const redisReplica = new kubernetes.apps.v1.Deployment("redis-replica", {
    spec: {
        selector: { matchLabels: {app: "redis-replica"} },
        replicas: 1,
        template: {
            metadata: { labels: {app: "redis-replica"} },
            spec: {
                containers: [{
                    name: "redis",
                    image: "pulumi/guestbook-redis-replica",
                    resources: { requests: { cpu: "100m", memory: "100Mi" } },
                    env: [{ name: "GET_HOSTS_FROM", value: "dns" }],
                    ports: [{
                        containerPort: 6379,
                        name: "redis",
                    }],
                }, {
                    name: "redis-exporter",
                    image: "bitnami/redis-exporter",
                    resources: { requests: { cpu: "100m", memory: "100Mi" } },
                    ports: [{
                        containerPort: 9121,
                        name: "prom",
                    }],
                }],
            },
        },
    },
});

const redisReplicaSvc = new kubernetes.core.v1.Service("redis-replica", {
    metadata: {
        name: "redis-replica",
        labels: {app: "guestbook"},
    },
    spec: {
        ports: [
            {port: 6379, name: "redis"},
            {port: 9121, name: "prom"},
        ],
        selector: redisReplica.spec.template.metadata.labels,
        type: "ClusterIP",
    },
});

const guestbook = new kubernetes.apps.v1.Deployment("guestbook", {
    spec: {
        selector: { matchLabels: {app: "guestbook"} },
        replicas: 3,
        template: {
            metadata: { labels: {app: "guestbook"} },
            spec: {
                containers: [{
                    name: "guestbook",
                    image: "pulumi/guestbook-php-redis",
                    resources: { requests: { cpu: "100m", memory: "100Mi" } },
                    env: [{ name: "GET_HOSTS_FROM", value: "dns" }],
                    ports: [{
                        containerPort: 80,
                        name: "http",
                    }],
                }, {
                    name: "apache-exporter",
                    image: "bitnami/apache-exporter",
                    resources: { requests: { cpu: "100m", memory: "100Mi" } },
                    ports: [{
                        containerPort: 9117,
                        name: "prom",
                    }],
                }],
            },
        },
    },
});
// bitnami/redis-exporter

const frontend = new kubernetes.core.v1.Service("frontend", {
    metadata: {
        name: "frontend",
        labels: {app: "guestbook"},
    },
    spec: {
        ports: [
            {port: 80, name: "http"},
            {port: 9117, name: "prom"},
        ],
        selector: guestbook.spec.template.metadata.labels,
        type: "ClusterIP",
    },
});

const prometheusStack = new kubernetes.helm.v3.Release("prometheus", {
    chart: "kube-prometheus-stack",
    namespace: namespace,
    repositoryOpts: {
        repo: "https://prometheus-community.github.io/helm-charts",
    },
    // skipCrds: true,
    // skipAwait: true,
    values: {
        alertmanager: {
            enabled: false
        },
        kubeStateMetrics: {
            enabled: false
        },
        nodeExporter: {
            enabled: false
        },
        grafana: {
            adminPassword: adminPassword,
            "grafana.ini": {
                server: {
                    enforce_domain: false,
                    root_url: "http://127.0.0.1/grafana",
                    serve_from_sub_path: true,
                },
            },
        },
        prometheus: {
            prometheusSpec: {
                externalUrl: "/prom/",
                routePrefix: "/prom/",
                serviceMonitorSelector: {
                    matchLabels: {app: "guestbook"},
                },
            },
        },
    },
    version: "92.17.1",
}, {
    deleteBeforeReplace: true,
});

const monitor = new serviceMonitor.monitoring.v1.ServiceMonitor("guestbook", {
    metadata: {
        labels: {
            app: "guestbook",
        }
    },
    spec: {
        namespaceSelector: {
            matchNames: ["default"],
        },
        selector: {
            matchLabels: {
                app: "guestbook",
            }
        },
        endpoints: [
            {port: "prom"}
        ],
    },
});

const ingress = new kubernetes.networking.v1.Ingress("guestbook", {
    metadata: {
        annotations: {
            "nginx.org/ssl-redirect": "false",
        },
    },
    spec: {
        ingressClassName: "nginx",
        defaultBackend: {
            service: {
                name: frontend.metadata.name,
                port: {
                    name: "http",
                },
            },
        },
        rules: [{
            http: {
                paths: [{
                    path: "/grafana",
                    pathType: "Prefix",
                    backend: {
                        service: {
                            name: pulumi.interpolate`${prometheusStack.name}-grafana`,
                            port: {
                                name: "http-web",
                            },
                        },
                    }
                }, {
                    path: "/prom",
                    pathType: "Prefix",
                    backend: {
                        service: {
                            name: pulumi.interpolate`${prometheusStack.name}-kube-p-prometheus`,
                            port: {
                                name: "http-web",
                            },
                        },
                    }
                }],
            }
        }],
    },
})

const dashboard = new kubernetes.yaml.v2.ConfigFile("dashboard", {
    file: "dashboard.yaml",
});


// export const frontendSvc = ingressController.name.apply(name => {
//     return kubernetes.core.v1.Service.get(`ingress-controller-svc`, `${ingressControllerNamespace}/${name}-nginx-ingress-controller`).status.loadBalancer.ingress;
// });
export const frontendIp = ingress.status.loadBalancer.ingress[0].ip;
export const grafanaUrl = pulumi.interpolate`http://${ingress.status.loadBalancer.ingress[0].ip}/grafana`;
